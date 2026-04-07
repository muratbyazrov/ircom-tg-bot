const cron = require('node-cron');
const {fetchAndCacheStats, sendDigests} = require('./digest.js');

const DIGEST_FETCH_CRON = process.env.DIGEST_FETCH_CRON || '0 9 * * *';   // 09:00 каждый день
const DIGEST_SEND_CRON  = process.env.DIGEST_SEND_CRON  || '0 10 * * *';  // 10:00 каждый день

function initScheduler(bot, webappUrl) {
    // 09:00 — собираем статистику за последние 24ч и кладём в кэш
    cron.schedule(DIGEST_FETCH_CRON, async () => {
        console.log('[scheduler] Fetching digest stats...');
        try {
            await fetchAndCacheStats();
        } catch (err) {
            console.error('[scheduler] Failed to fetch stats:', err.message);
        }
    }, {timezone: 'Europe/Moscow'});

    // 10:00 — рассылаем персональные дайджесты
    cron.schedule(DIGEST_SEND_CRON, async () => {
        console.log('[scheduler] Sending daily digest...');
        try {
            await sendDigests(bot, webappUrl);
        } catch (err) {
            console.error('[scheduler] Failed to send digests:', err.message);
        }
    }, {timezone: 'Europe/Moscow'});

    console.log(`[scheduler] Digest fetch: ${DIGEST_FETCH_CRON}, send: ${DIGEST_SEND_CRON} (Europe/Moscow)`);
}

module.exports = {initScheduler};
