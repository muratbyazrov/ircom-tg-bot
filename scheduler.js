const cron = require('node-cron');
const {fetchAndCacheStats, sendDigests} = require('./digest.js');
const {createLogger} = require('./logger.js');

const log = createLogger('scheduler');

const DIGEST_FETCH_CRON = process.env.DIGEST_FETCH_CRON || '0 9 * * *';   // 09:00 каждый день
const DIGEST_SEND_CRON  = process.env.DIGEST_SEND_CRON  || '0 10 * * *';  // 10:00 каждый день

function initScheduler(bot, webappUrl) {
    // 09:00 — собираем статистику за последние 24ч и кладём в кэш
    cron.schedule(DIGEST_FETCH_CRON, async () => {
        log.info('Cron triggered: fetching digest stats');
        const t0 = Date.now();
        try {
            await fetchAndCacheStats();
            log.info(`Cron done: stats fetched and cached in ${Date.now() - t0}ms`);
        } catch (err) {
            log.error(`Cron failed: fetch stats — ${err.message}`, err);
        }
    }, {timezone: 'Europe/Moscow'});

    // 10:00 — рассылаем персональные дайджесты
    cron.schedule(DIGEST_SEND_CRON, async () => {
        log.info('Cron triggered: sending daily digests');
        const t0 = Date.now();
        try {
            const result = await sendDigests(bot, webappUrl);
            log.info(`Cron done: digests sent in ${Date.now() - t0}ms — sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`);
        } catch (err) {
            log.error(`Cron failed: send digests — ${err.message}`, err);
        }
    }, {timezone: 'Europe/Moscow'});

    log.info(`Scheduler initialized — fetch: "${DIGEST_FETCH_CRON}" send: "${DIGEST_SEND_CRON}" tz: Europe/Moscow`);
}

module.exports = {initScheduler};
