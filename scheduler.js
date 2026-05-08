const cron = require('node-cron');
const {runDigest} = require('./digest.js');
const {createLogger} = require('./logger.js');

const log = createLogger('scheduler');

const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE || 'Europe/Moscow';
const DIGEST_SEND_CRON = process.env.DIGEST_SEND_CRON || '0 10 * * *';  // 10:00 каждый день
const CATCHUP_WINDOW_HOURS = 14; // сколько часов после планового времени считаем "догоняемым" (10:00 → до 00:00)

let _notifyAdmin = null;

function setAdminNotifier(fn) {
    _notifyAdmin = fn;
}

async function notifyAdmin(lines) {
    if (!_notifyAdmin) return;
    try {
        await _notifyAdmin(lines);
    } catch (err) {
        log.warn(`Failed to send admin notification: ${err.message}`);
    }
}

// Парсим час из cron-выражения вида "0 10 * * *"
function parseDigestHour() {
    const parts = DIGEST_SEND_CRON.trim().split(/\s+/);
    const h = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;
    return isNaN(h) ? 10 : h;
}

function getCurrentHourInTz(tz) {
    return parseInt(new Intl.DateTimeFormat('en-US', {
        hour:   'numeric',
        hour12: false,
        timeZone: tz,
    }).format(new Date()), 10);
}

async function catchupDigestIfOverdue(bot, webappUrl) {
    const digestHour = parseDigestHour();
    const currentHour = getCurrentHourInTz(DIGEST_TIMEZONE);

    if (currentHour < digestHour || currentHour >= digestHour + CATCHUP_WINDOW_HOURS) {
        log.debug(`Catchup: hour=${currentHour} outside window [${digestHour}, ${digestHour + CATCHUP_WINDOW_HOURS}) — skipping`);
        return;
    }

    log.info(`Catchup: ${DIGEST_TIMEZONE} hour=${currentHour}, digest at ${digestHour} — checking for missed sends after restart`);
    try {
        const result = await runDigest(bot, webappUrl);
        if (result.sent > 0) {
            log.info(`Catchup sent ${result.sent} missed digest(s)`);
            await notifyAdmin([
                `ℹ️ [digest] Catchup при старте: отправлено ${result.sent}`,
                `Вероятно, бот перезапускался во время плановой рассылки`,
            ]);
        } else {
            log.debug(`Catchup: nothing to send (skipped=${result.skipped}, likely already sent before restart)`);
        }
    } catch (err) {
        log.error(`Catchup digest failed: ${err.message}`);
    }
}

async function runCronDigest(bot, webappUrl) {
    const now = new Date().toISOString();
    log.info(`Cron SEND triggered at ${now}`);
    const t0 = Date.now();
    try {
        const result = await runDigest(bot, webappUrl);
        const elapsed = Date.now() - t0;
        log.info(`Cron SEND done in ${elapsed}ms — sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`);
        if (result.skipped > 0) {
            log.info(`Cron SEND skipped reasons: ${JSON.stringify(result.skippedReasons)}`);
        }

        if (result.sent === 0) {
            await notifyAdmin([
                '⚠️ [digest] Cron SEND: отправлено 0 сообщений',
                `Время: ${now}`,
                `skipped=${result.skipped} failed=${result.failed}`,
                `Причины пропуска: ${JSON.stringify(result.skippedReasons)}`,
            ]);
        } else if (result.failed > 0) {
            await notifyAdmin([
                `⚠️ [digest] Cron SEND: ${result.failed} ошибок при отправке`,
                `Время: ${now}`,
                `sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`,
            ]);
        }
    } catch (err) {
        const elapsed = Date.now() - t0;
        log.error(`Cron SEND FAILED in ${elapsed}ms: ${err.message}`, err);
        await notifyAdmin([
            '🔴 [digest] Cron SEND упал с исключением',
            `Время: ${now}`,
            `Ошибка: ${err.message}`,
        ]);
    }
}

function initScheduler(bot, webappUrl) {
    cron.schedule(DIGEST_SEND_CRON, () => runCronDigest(bot, webappUrl), {timezone: DIGEST_TIMEZONE});

    log.info(`Scheduler initialized — send: "${DIGEST_SEND_CRON}" tz: ${DIGEST_TIMEZONE}`);

    // Если бот перезапустился после планового времени — отправить пропущенное
    setImmediate(() => catchupDigestIfOverdue(bot, webappUrl));
}

module.exports = {initScheduler, setAdminNotifier};
