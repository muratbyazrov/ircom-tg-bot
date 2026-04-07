const https = require('https');
const http = require('http');
const {saveDigestCache, getDigestCache, getAllActiveSubscribers, markSent, upsertSubscriber} = require('./db.js');

const API_URL = process.env.API_URL || 'http://127.0.0.1:3002/ircom-api/v1';

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
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON from API: ' + data));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(new Error('API request timeout')); });
        req.write(payload);
        req.end();
    });
}

// ── Получение статистики ───────────────────────────────────────────────────────

async function fetchStats() {
    const result = await apiRequest({
        domain: 'digest',
        event:  'getDigestStats',
        params: {},
    });

    if (result.error) {
        throw new Error('API error: ' + JSON.stringify(result.error));
    }

    return result.data || {listings: null, taxi: null};
}

async function fetchAndCacheStats() {
    const stats = await fetchStats();
    saveDigestCache(JSON.stringify(stats));
    console.log('[digest] Stats cached at', new Date().toISOString());
    return stats;
}

function getCachedStats() {
    const row = getDigestCache();
    if (!row) return null;
    try {
        return JSON.parse(row.stats_json);
    } catch {
        return null;
    }
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
            timeZone: 'Europe/Moscow',
        }).format(new Date(iso));
    } catch {
        return null;
    }
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

function buildDigestText(firstName, stats) {
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

    if (lines.length === 0) return null;

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

    const lastSentAt = subscriber.last_sent_at ? subscriber.last_sent_at * 1000 : 0;
    const now = Date.now();

    if (freq === 'daily') {
        // Отправить если ещё не отправляли сегодня
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        if (lastSentAt < todayStart.getTime()) return {ok: true};
        return {ok: false, reason: 'daily_already_sent_today'};
    }

    if (freq === 'every3days') {
        if (now - lastSentAt > 3 * 24 * 60 * 60 * 1000) return {ok: true};
        return {ok: false, reason: 'every3days_wait_interval'};
    }

    if (freq === 'only10plus') {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        if (lastSentAt >= todayStart.getTime()) {
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

async function sendDigests(bot, webappUrl) {
    const stats = getCachedStats();
    const subscribers = getAllActiveSubscribers();

    const summary = buildStatsSummary(stats);
    const byFrequency = subscribers.reduce((acc, sub) => {
        incrementCounter(acc, sub.frequency || 'unknown');
        return acc;
    }, {});

    console.log(
        `[digest] Stats: categories=${summary.categories} listings=${summary.listingCount} taxi=${summary.taxiCount} total=${summary.total}`
    );
    console.log(
        `[digest] Subscribers: total=${subscribers.length} by_frequency=${JSON.stringify(byFrequency)}`
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const skippedReasons = {};

    for (const sub of subscribers) {
        const decision = getSendDecision(sub, stats);
        if (!decision.ok) {
            skipped++;
            incrementCounter(skippedReasons, decision.reason || 'unknown');
            continue;
        }

        const text = buildDigestText(sub.first_name, stats);
        if (!text) {
            skipped++;
            incrementCounter(skippedReasons, 'no_content');
            continue;
        }

        try {
            await bot.telegram.sendMessage(sub.telegram_id, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '📱 Перейти в приложение', url: webappUrl}],
                        [{text: '⚙️ Настройки уведомлений', callback_data: 'digest_settings'}],
                    ],
                },
            });
            markSent(sub.telegram_id);
            sent++;
        } catch (err) {
            console.error(`[digest] Failed to send to ${sub.telegram_id}:`, err.message);
            failed++;
        }
    }

    console.log(`[digest] Done: sent=${sent} skipped=${skipped} failed=${failed}`);
    if (skipped > 0) {
        console.log(`[digest] Skipped reasons: ${JSON.stringify(skippedReasons)}`);
    }

    return {sent, skipped, failed, skippedReasons};
}

async function syncSubscribersFromApi() {
    const result = await apiRequest({
        domain: 'account',
        event:  'getTelegramSubscribers',
        params: {},
    });

    const subscribers = result.data || [];
    for (const sub of subscribers) {
        if (!sub.telegramUserId) continue;
        upsertSubscriber({
            telegramId: sub.telegramUserId,
            firstName:  sub.name || null,
            username:   null,
        });
    }

    console.log(`[digest] Synced ${subscribers.length} subscribers from API`);
}

async function runDigest(bot, webappUrl) {
    try {
        await syncSubscribersFromApi();
    } catch (err) {
        console.error('[digest] Failed to sync subscribers, using existing DB:', err.message);
    }
    await fetchAndCacheStats();
    return sendDigests(bot, webappUrl);
}

module.exports = {
    fetchAndCacheStats,
    getCachedStats,
    buildDigestText,
    sendDigests,
    runDigest,
    totalCount,
};
