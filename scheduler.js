const cron = require('node-cron');
const {fetchAndCacheStats, sendDigests} = require('./digest.js');
const {createLogger} = require('./logger.js');

const log = createLogger('scheduler');

const DIGEST_FETCH_CRON = process.env.DIGEST_FETCH_CRON || '0 9 * * *';   // 09:00 каждый день
const DIGEST_SEND_CRON  = process.env.DIGEST_SEND_CRON  || '0 10 * * *';  // 10:00 каждый день

// Уведомление администратора (устанавливается при инициализации)
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
    // 09:00 — собираем статистику за последние 24ч и кладём в кэш
    cron.schedule(DIGEST_FETCH_CRON, async () => {
        const now = new Date().toISOString();
        log.info(`Cron FETCH triggered at ${now}`);
        const t0 = Date.now();
        try {
            await fetchAndCacheStats();
            const elapsed = Date.now() - t0;
            log.info(`Cron FETCH done in ${elapsed}ms`);
        } catch (err) {
            const elapsed = Date.now() - t0;
            log.error(`Cron FETCH FAILED in ${elapsed}ms: ${err.message}`, err);
            await notifyAdmin([
                '🔴 [digest] Cron FETCH упал',
                `Время: ${now}`,
                `Ошибка: ${err.message}`,
                'Статистика не кэширована — в 10:00 дайджест НЕ отправится',
            ]);
        }
    }, {timezone: 'Europe/Moscow'});

    // 10:00 — рассылаем персональные дайджесты
    cron.schedule(DIGEST_SEND_CRON, async () => {
        const now = new Date().toISOString();
        log.info(`Cron SEND triggered at ${now}`);
        const t0 = Date.now();
        try {
            const result = await sendDigests(bot, webappUrl);
            const elapsed = Date.now() - t0;
            log.info(`Cron SEND done in ${elapsed}ms — sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`);
            if (result.skipped > 0) {
                log.info(`Cron SEND skipped reasons: ${JSON.stringify(result.skippedReasons)}`);
            }

            // Алёрт если вообще никому не отправили, но подписчики есть
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
    }, {timezone: 'Europe/Moscow'});

    log.info(`Scheduler initialized — fetch: "${DIGEST_FETCH_CRON}" send: "${DIGEST_SEND_CRON}" tz: Europe/Moscow`);
}

module.exports = {initScheduler, setAdminNotifier};
