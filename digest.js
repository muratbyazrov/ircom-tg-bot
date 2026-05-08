const https = require('https');
const http = require('http');
const {createLogger} = require('./logger.js');

const log = createLogger('digest');

const API_URL = process.env.API_URL || 'http://127.0.0.1:3002/ircom-api/v1';
const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE || 'Europe/Moscow';

// ── Emoji map по категориям объявлений ─────────────────────────────────────────

const CATEGORY_EMOJI = {
    'Авто':          '🚗',
    'Мото':          '🏍',
    'Недвижимость':  '🏠',
    'Электроника':   '📱',
    'Работа':        '💼',
    'Одежда':        '👗',
    'Мебель':        '🛋',
    'Животные':      '🐾',
    'Спорт':         '⚽',
    'Услуги':        '🔧',
};

function categoryEmoji(name) {
    if (!name) return '📌';
    for (const [key, emoji] of Object.entries(CATEGORY_EMOJI)) {
        if (name.toLowerCase().includes(key.toLowerCase())) return emoji;
    }
    return '📌';
}

// ── HTTP запрос к ircom-api ────────────────────────────────────────────────────

function apiRequest(body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const url = new URL(API_URL);
        const lib = url.protocol === 'https:' ? https : http;
        const t0 = Date.now();
        log.debug(`API request → domain=${body.domain} event=${body.event}`);
        const req = lib.request({
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    log.debug(`API response ← domain=${body.domain} event=${body.event} status=${res.statusCode} in ${Date.now() - t0}ms`);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Invalid JSON from API: ' + data));
                }
            });
        });
        req.on('error', (err) => {
            log.error(`API request error domain=${body.domain} event=${body.event}: ${err.message}`);
            reject(err);
        });
        req.setTimeout(10000, () => { req.destroy(new Error('API request timeout')); });
        req.write(payload);
        req.end();
    });
}

// ── Получение статистики ───────────────────────────────────────────────────────

async function fetchStats() {
    log.info('Fetching digest stats from API...');
    const result = await apiRequest({
        domain: 'digest',
        event:  'getDigestStats',
        params: {},
    });

    if (result.error) {
        throw new Error('API error: ' + JSON.stringify(result.error));
    }

    const data = result.data || {listings: null, taxi: null};
    const listings = data.listings || [];
    const nonZero = listings.filter((i) => Number(i.count) > 0);
    const total = nonZero.reduce((s, i) => s + Number(i.count), 0);
    log.info(`Stats fetched: ${listings.length} categories in response, ${nonZero.length} non-empty, total listings=${total}, taxi=${data.taxi ? `count=${data.taxi.count} minPrice=${data.taxi.minPrice}` : 'нет'}`);
    if (nonZero.length > 0) {
        const breakdown = nonZero.map((i) => `${i.category}:${i.count}`).join(', ');
        log.info(`Categories breakdown: ${breakdown}`);
    } else {
        log.warn('API returned ZERO non-empty categories — digest will have no content');
    }
    if (!data.taxi || Number(data.taxi.count) === 0) {
        log.warn('API returned no taxi data');
    }
    return data;
}


// ── Форматирование текста дайджеста ────────────────────────────────────────────

function formatPrice(price) {
    if (price == null) return null;
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 1) return null;
    return n.toLocaleString('ru-RU') + ' ₽';
}

function formatTime(iso) {
    if (!iso) return null;
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: DIGEST_TIMEZONE,
        }).format(new Date(iso));
    } catch {
        return null;
    }
}

function getDayKeyInTimeZone(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year:  'numeric',
        month: '2-digit',
        day:   '2-digit',
    }).formatToParts(new Date(timestamp));

    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;

    return `${year}-${month}-${day}`;
}

const MIN_LISTINGS_TO_SHOW = 3;
const MAX_CATEGORIES = 5;

function pluralListings(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return `${n} объявлений`;
    if (mod10 === 1) return `${n} объявление`;
    if (mod10 >= 2 && mod10 <= 4) return `${n} объявления`;
    return `${n} объявлений`;
}

function listingLine(category, count) {
    const emoji = categoryEmoji(category);
    return `${emoji} <b>${category}</b> — ${pluralListings(count)}`;
}

function taxiLine(count, minPrice, firstDeparture) {
    const priceStr = formatPrice(minPrice);
    const timeStr = formatTime(firstDeparture);

    const parts = [];
    if (priceStr) parts.push(`от ${priceStr}`);
    if (timeStr) parts.push(`первый в ${timeStr}`);

    const suffix = parts.length > 0 ? `, ${parts.join(', ')}` : '';
    return `🚕 <b>Такси во Владикавказ</b> — ${count} рейсов${suffix}`;
}

function buildDigestText(firstName, stats, {silent = false} = {}) {
    if (!stats) return null;

    // Группируем категории с одинаковым названием и фильтруем малозначимые
    const grouped = new Map();
    for (const item of (stats.listings || [])) {
        const count = Number(item.count) || 0;
        if (count < 1) continue;
        const key = item.category || 'Другое';
        grouped.set(key, (grouped.get(key) || 0) + count);
    }

    // Недвижимость показываем всегда если есть хоть одно объявление, остальные — от MIN_LISTINGS_TO_SHOW
    // "Другое" не показываем — неинформативно
    const topCategories = [...grouped.entries()]
        .filter(([category, count]) => {
            if (category === 'Другое') return false;
            if (category === 'Недвижимость') return count >= 1;
            return count >= MIN_LISTINGS_TO_SHOW;
        })
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_CATEGORIES);

    const lines = [];

    if (topCategories.length > 0) {
        lines.push('Вот что появилось за сутки в ircom:');
        lines.push('');
        for (const [category, count] of topCategories) {
            lines.push(listingLine(category, count));
        }
    }

    // Такси
    const taxi = stats.taxi;
    if (taxi && Number(taxi.count) > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(taxiLine(taxi.count, taxi.minPrice, taxi.firstDeparture));
    }

    if (lines.length === 0) {
        if (!silent) {
            log.warn('buildDigestText: no content — topCategories.length=0, taxi empty. Stats had no usable data.');
        }
        return null;
    }

    const name = firstName || 'друг';
    return [`Привет, ${name}! 👋`, '', ...lines].join('\n');
}

// ── Подсчёт общего количества новых объявлений (для фильтра only10plus) ────────

function totalCount(stats) {
    if (!stats) return 0;
    const listingCount = (stats.listings || []).reduce((s, i) => s + (Number(i.count) || 0), 0);
    const taxiCount = stats.taxi ? (Number(stats.taxi.count) || 0) : 0;
    return listingCount + taxiCount;
}

// ── Рассылка дайджестов ────────────────────────────────────────────────────────

function getSendDecision(subscriber, stats) {
    const freq = subscriber.frequency;
    if (freq === 'disabled') return {ok: false, reason: 'disabled'};

    const lastSentAt = subscriber.digestSentAt ? new Date(subscriber.digestSentAt).getTime() : 0;
    const now = Date.now();
    const todayKey = getDayKeyInTimeZone(now, DIGEST_TIMEZONE);
    const lastSentDayKey = lastSentAt ? getDayKeyInTimeZone(lastSentAt, DIGEST_TIMEZONE) : null;

    if (freq === 'daily') {
        if (lastSentDayKey !== todayKey) return {ok: true};
        return {ok: false, reason: 'daily_already_sent_today'};
    }

    if (freq === 'every3days') {
        if (now - lastSentAt > 3 * 24 * 60 * 60 * 1000) return {ok: true};
        return {ok: false, reason: 'every3days_wait_interval'};
    }

    if (freq === 'only10plus') {
        if (lastSentDayKey === todayKey) {
            return {ok: false, reason: 'only10plus_already_sent_today'};
        }
        if (totalCount(stats) >= 10) return {ok: true};
        return {ok: false, reason: 'only10plus_less_than_10'};
    }

    return {ok: false, reason: 'unknown_frequency'};
}

function shouldSend(subscriber, stats) {
    return getSendDecision(subscriber, stats).ok;
}

function incrementCounter(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
}

function buildStatsSummary(stats) {
    const listingCount = (stats?.listings || []).reduce((s, i) => s + (Number(i.count) || 0), 0);
    const taxiCount = stats?.taxi ? (Number(stats.taxi.count) || 0) : 0;
    const categories = (stats?.listings || []).filter((i) => Number(i.count) > 0).length;
    return {
        categories,
        listingCount,
        taxiCount,
        total: listingCount + taxiCount,
    };
}

async function fetchSubscribers() {
    log.info('Fetching subscribers from API...');
    const result = await apiRequest({
        domain: 'account',
        event:  'getTelegramSubscribers',
        params: {},
    });
    const subscribers = (result.data || []).filter((s) => s.telegramUserId);
    log.info(`Fetched ${subscribers.length} subscribers from API`);
    return subscribers;
}

async function markSentInApi(telegramUserId) {
    try {
        await apiRequest({
            domain: 'digest',
            event:  'markDigestSent',
            params: {telegramUserId: Number(telegramUserId)},
        });
    } catch (err) {
        log.warn(`Failed to mark digest sent in API for user=${telegramUserId}: ${err.message}`);
    }
}

async function sendDigests(bot, webappUrl, subscribers, stats) {
    const summary = buildStatsSummary(stats);
    const byFrequency = subscribers.reduce((acc, sub) => {
        incrementCounter(acc, sub.telegramDigestFrequency || 'unknown');
        return acc;
    }, {});

    log.info(`Send started — subscribers: ${subscribers.length} (${JSON.stringify(byFrequency)})`);
    log.info(`Stats summary: categories=${summary.categories} listings=${summary.listingCount} taxi=${summary.taxiCount} total=${summary.total}`);

    const sampleText = buildDigestText('test', stats, {silent: true});
    if (!sampleText) {
        log.warn('sendDigests: digest text is empty for ALL subscribers (API returned no usable data) — everyone will be skipped with no_content');
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const skippedReasons = {};

    for (const sub of subscribers) {
        // Приводим поля API к формату ожидаемому getSendDecision
        const normalized = {
            frequency:   sub.telegramDigestFrequency || 'daily',
            digestSentAt: sub.telegramDigestSentAt || null,
        };

        const decision = getSendDecision(normalized, stats);
        if (!decision.ok) {
            skipped++;
            incrementCounter(skippedReasons, decision.reason || 'unknown');
            log.debug(`Skip user=${sub.telegramUserId} reason=${decision.reason} freq=${normalized.frequency} last_sent=${normalized.digestSentAt || 'never'}`);
            continue;
        }

        const text = buildDigestText(sub.name, stats, {silent: true});
        if (!text) {
            skipped++;
            incrementCounter(skippedReasons, 'no_content');
            log.debug(`Skip user=${sub.telegramUserId} reason=no_content`);
            continue;
        }

        try {
            await bot.telegram.sendMessage(sub.telegramUserId, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '📱 Перейти в приложение', url: webappUrl}],
                        [{text: '⚙️ Настройки уведомлений', callback_data: 'digest_settings'}],
                    ],
                },
            });
            markSentInApi(sub.telegramUserId);
            sent++;
            log.debug(`Sent digest to user=${sub.telegramUserId}`);
        } catch (err) {
            log.error(`Failed to send digest to user=${sub.telegramUserId}: ${err.message}`);
            failed++;
        }
    }

    log.info(`Send done — sent=${sent} skipped=${skipped} failed=${failed}`);
    if (skipped > 0) log.info(`Skipped reasons breakdown: ${JSON.stringify(skippedReasons)}`);
    if (failed > 0) log.warn(`${failed} message(s) failed to send`);
    if (sent === 0 && subscribers.length > 0) {
        log.warn(`sendDigests: sent 0 out of ${subscribers.length} active subscribers — investigate skipped reasons above`);
    }

    return {sent, skipped, failed, skippedReasons};
}

async function runDigest(bot, webappUrl) {
    log.info('=== runDigest started ===');
    const t0 = Date.now();
    const [subscribers, stats] = await Promise.all([
        fetchSubscribers(),
        fetchStats(),
    ]);
    const result = await sendDigests(bot, webappUrl, subscribers, stats);
    log.info(`=== runDigest completed in ${Date.now() - t0}ms — sent=${result.sent} skipped=${result.skipped} failed=${result.failed} ===`);
    return result;
}

async function getDigestSettings(telegramUserId) {
    try {
        const result = await apiRequest({
            domain: 'digest',
            event:  'getDigestSettings',
            params: {telegramUserId: Number(telegramUserId)},
        });
        return result.data || null;
    } catch (err) {
        log.warn(`Failed to get digest settings for user=${telegramUserId}: ${err.message}`);
        return null;
    }
}

async function setDigestFrequency(telegramUserId, frequency) {
    await apiRequest({
        domain: 'digest',
        event:  'setDigestFrequency',
        params: {telegramUserId: Number(telegramUserId), frequency},
    });
}

module.exports = {
    fetchStats,
    buildDigestText,
    sendDigests,
    runDigest,
    fetchSubscribers,
    markSentInApi,
    getDigestSettings,
    setDigestFrequency,
    totalCount,
};
