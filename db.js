const Database = require('better-sqlite3');
const path = require('path');
const {createLogger} = require('./logger.js');

const log = createLogger('db');

const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, 'data', 'bot.db');

let _db = null;

function getDb() {
    if (_db) return _db;

    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }

    log.info(`Opening database: ${DB_PATH}`);
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    log.info('Database ready (WAL mode)');

    _db.exec(`
        CREATE TABLE IF NOT EXISTS subscribers (
            telegram_id  INTEGER PRIMARY KEY,
            first_name   TEXT,
            username     TEXT,
            frequency    TEXT NOT NULL DEFAULT 'daily',
            last_sent_at INTEGER,
            created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS digest_cache (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            fetched_at  INTEGER NOT NULL,
            stats_json  TEXT NOT NULL
        );
    `);

    return _db;
}

// ── Subscribers ────────────────────────────────────────────────────────────────

function upsertSubscriber({telegramId, firstName, username}) {
    log.debug(`upsertSubscriber telegramId=${telegramId} username=@${username || 'n/a'}`);
    getDb().prepare(`
        INSERT INTO subscribers (telegram_id, first_name, username)
        VALUES (@telegramId, @firstName, @username)
        ON CONFLICT (telegram_id) DO UPDATE SET
            first_name = excluded.first_name,
            username   = excluded.username
    `).run({telegramId, firstName: firstName || null, username: username || null});
}

function setFrequency(telegramId, frequency) {
    const allowed = ['daily', 'every3days', 'only10plus', 'disabled'];
    if (!allowed.includes(frequency)) throw new Error('Unknown frequency: ' + frequency);
    log.info(`setFrequency telegramId=${telegramId} frequency=${frequency}`);
    getDb().prepare(
        `UPDATE subscribers SET frequency = ? WHERE telegram_id = ?`
    ).run(frequency, telegramId);
}

function getSubscriber(telegramId) {
    return getDb().prepare(
        `SELECT * FROM subscribers WHERE telegram_id = ?`
    ).get(telegramId) || null;
}

function getAllActiveSubscribers() {
    return getDb().prepare(
        `SELECT * FROM subscribers WHERE frequency != 'disabled'`
    ).all();
}

function markSent(telegramId) {
    getDb().prepare(
        `UPDATE subscribers SET last_sent_at = strftime('%s', 'now') WHERE telegram_id = ?`
    ).run(telegramId);
}

// ── Digest cache ───────────────────────────────────────────────────────────────

function saveDigestCache(statsJson) {
    getDb().prepare(`
        INSERT INTO digest_cache (id, fetched_at, stats_json)
        VALUES (1, strftime('%s', 'now'), ?)
        ON CONFLICT (id) DO UPDATE SET
            fetched_at = excluded.fetched_at,
            stats_json = excluded.stats_json
    `).run(statsJson);
}

function getDigestCache() {
    return getDb().prepare(`SELECT * FROM digest_cache WHERE id = 1`).get() || null;
}

module.exports = {
    upsertSubscriber,
    setFrequency,
    getSubscriber,
    getAllActiveSubscribers,
    markSent,
    saveDigestCache,
    getDigestCache,
};
