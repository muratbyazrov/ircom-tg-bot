const cron = require('node-cron');
const {runDigest} = require('./digest.js');
const {createLogger} = require('./logger.js');

const log = createLogger('scheduler');

const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE || 'Europe/Moscow';
const DIGEST_SEND_CRON = process.env.DIGEST_SEND_CRON || '0 10 * * *';  // 10:00 каждый день

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

function initScheduler(bot, webappUrl) {
    cron.schedule(DIGEST_SEND_CRON, async () => {
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
    }, {timezone: DIGEST_TIMEZONE});

    log.info(`Scheduler initialized — send: "${DIGEST_SEND_CRON}" tz: ${DIGEST_TIMEZONE}`);
}

module.exports = {initScheduler, setAdminNotifier};
