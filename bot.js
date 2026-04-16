require('dotenv').config();

const crypto  = require('crypto');
const express = require('express');
const {Telegraf, Markup} = require('telegraf');

const {upsertSubscriber, setFrequency, getSubscriber, getAllActiveSubscribers, getDigestCache} = require('./db.js');
const {initScheduler, setAdminNotifier} = require('./scheduler.js');
const {runDigest, buildDigestText, getCachedStats, fetchAndCacheStats} = require('./digest.js');
const {createLogger} = require('./logger.js');

const log = createLogger('bot');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL   = process.env.WEBAPP_URL;
const PORT         = Number(process.env.PORT || 3000);

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
    throw new Error('Set BOT_TOKEN, ADMIN_CHAT_ID and WEBAPP_URL in .env');
}

const START_BUTTON_TEXT = 'Запустить';

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ── Helpers ────────────────────────────────────────────────────────────────────

function isTelegramDeepLink(url) {
    return /^https:\/\/t\.me\//i.test(url);
}

function buildStartButton() {
    return isTelegramDeepLink(WEBAPP_URL)
        ? Markup.inlineKeyboard([Markup.button.url(START_BUTTON_TEXT, WEBAPP_URL)])
        : Markup.keyboard([[Markup.button.webApp(START_BUTTON_TEXT, WEBAPP_URL)]]).resize();
}

function parseInitData(initData) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) throw new Error('hash is missing in initData');

    const dataCheckString = [...params.entries()]
        .filter(([key]) => key !== 'hash')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    if (expectedHash !== hash) throw new Error('invalid initData hash');

    return Object.fromEntries(params.entries());
}

// ── Настройки уведомлений (inline keyboard) ───────────────────────────────────

const FREQUENCY_LABELS = {
    daily:      '📅 Каждый день',
    every3days: '📆 Раз в 3 дня',
    only10plus: '🔥 Когда > 10 объявлений',
    disabled:   '🔕 Отключить',
};

function buildSettingsKeyboard(currentFreq) {
    return Markup.inlineKeyboard([
        ...Object.entries(FREQUENCY_LABELS).map(([value, label]) => [
            Markup.button.callback(
                (value === currentFreq ? '✅ ' : '') + label,
                `freq:${value}`
            ),
        ]),
        [Markup.button.callback('✖️ Закрыть', 'settings_close')],
    ]);
}

function settingsText(sub) {
    const freq = sub ? sub.frequency : 'daily';
    return [
        '⚙️ <b>Настройки уведомлений</b>',
        '',
        'Выберите частоту дайджеста:',
        '',
        `Текущая настройка: <b>${FREQUENCY_LABELS[freq] || freq}</b>`,
    ].join('\n');
}

// ── Уведомление администратора ────────────────────────────────────────────────

async function notifyAdmin(lines) {
    try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, lines.join('\n'));
    } catch (err) {
        log.warn(`Failed to notify admin: ${err.message}`);
    }
}

// ── /start ─────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
    const from = ctx.from || {};
    log.info(`/start — user=${from.id} username=@${from.username || 'n/a'} name=${from.first_name || 'n/a'}`);

    // Регистрируем пользователя в базе подписчиков
    upsertSubscriber({
        telegramId: from.id,
        firstName:  from.first_name,
        username:   from.username,
    });

    await notifyAdmin([
        '▶️ /start в боте',
        `id: ${from.id ?? 'n/a'}`,
        `username: @${from.username ?? 'n/a'}`,
        `name: ${[from.first_name, from.last_name].filter(Boolean).join(' ') || 'n/a'}`,
    ]);

    await ctx.replyWithHTML(
        [
            'Добро пожаловать в <b>ircom</b>!',
            'Приложение для Цхинвала, где все важное под рукой.',
            `Нажмите кнопку <b>«${START_BUTTON_TEXT}»</b>, чтобы перейти в приложение.`,
        ].join('\n\n'),
        buildStartButton()
    );
});

// ── Callback-кнопки ────────────────────────────────────────────────────────────

// Открытие настроек уведомлений
bot.action('digest_settings', async (ctx) => {
    await ctx.answerCbQuery();
    const sub = getSubscriber(ctx.from.id);
    await ctx.reply(settingsText(sub), {
        parse_mode: 'HTML',
        ...buildSettingsKeyboard(sub?.frequency || 'daily'),
    });
});

// Закрытие настроек
bot.action('settings_close', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
});

// Выбор частоты
bot.action(/^freq:(.+)$/, async (ctx) => {
    const freq = ctx.match[1];
    const allowed = ['daily', 'every3days', 'only10plus', 'disabled'];
    if (!allowed.includes(freq)) {
        log.warn(`Unknown frequency setting "${freq}" from user=${ctx.from.id}`);
        return ctx.answerCbQuery('Неизвестная настройка');
    }

    log.info(`Frequency set — user=${ctx.from.id} freq=${freq}`);

    // Убеждаемся, что пользователь есть в базе
    upsertSubscriber({
        telegramId: ctx.from.id,
        firstName:  ctx.from.first_name,
        username:   ctx.from.username,
    });

    setFrequency(ctx.from.id, freq);
    await ctx.answerCbQuery('Сохранено ✅');

    // Обновляем сообщение с настройками
    const sub = getSubscriber(ctx.from.id);
    try {
        await ctx.editMessageText(settingsText(sub), {
            parse_mode: 'HTML',
            ...buildSettingsKeyboard(freq),
        });
    } catch {
        // Если сообщение не изменилось — просто игнорируем
    }
});

// ── /preview — тестовый просмотр дайджеста ────────────────────────────────────

bot.command('preview', async (ctx) => {
    const from = ctx.from || {};
    log.info(`/preview — user=${from.id} username=@${from.username || 'n/a'}`);
    try {
        await ctx.reply('⏳ Загружаю статистику...');
        const stats = await fetchAndCacheStats();
        const text = buildDigestText(from.first_name || 'друг', stats);
        if (!text) {
            return ctx.reply('(нет данных для дайджеста — API вернул пустую статистику)');
        }
        await ctx.replyWithHTML(text, {
            reply_markup: {
                inline_keyboard: [
                    [{text: '📱 Перейти в приложение', url: WEBAPP_URL}],
                    [{text: '⚙️ Настройки уведомлений', callback_data: 'digest_settings'}],
                ],
            },
        });
    } catch (err) {
        await ctx.reply(`Ошибка: ${err.message}`);
    }
});

// ── web_app_data (sendData из Mini App) ───────────────────────────────────────

bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg?.web_app_data) return next();

    const from = msg.from || {};
    const payload = msg.web_app_data.data;

    await notifyAdmin([
        '📩 Mini App sendData()',
        `id: ${from.id ?? 'n/a'}`,
        `username: @${from.username ?? 'n/a'}`,
        `payload: ${payload}`,
    ]);

    await ctx.reply('Данные из Mini App получены.');
});

// ── HTTP: Mini App открыт ─────────────────────────────────────────────────────

app.post('/webapp/open', async (req, res) => {
    try {
        const initData = req.body?.initData;
        if (!initData) {
            log.warn('POST /webapp/open — missing initData');
            return res.status(400).json({ok: false, error: 'initData is required'});
        }

        const data = parseInitData(initData);
        const user = data.user ? JSON.parse(data.user) : null;

        if (user?.id) {
            log.info(`POST /webapp/open — user=${user.id} username=@${user.username || 'n/a'}`);
            // Регистрируем пользователя при первом открытии Mini App
            upsertSubscriber({
                telegramId: user.id,
                firstName:  user.first_name,
                username:   user.username,
            });
        }

        await notifyAdmin([
            '🚀 Кто-то открыл Mini App',
            `id: ${user?.id ?? 'n/a'}`,
            `username: @${user?.username ?? 'n/a'}`,
            `name: ${[user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'n/a'}`,
            `language_code: ${user?.language_code ?? 'n/a'}`,
            `is_premium: ${user?.is_premium ? 'yes' : 'no'}`,
        ]);

        return res.json({ok: true, user_id: user?.id ?? null});
    } catch (error) {
        log.warn(`POST /webapp/open — auth failed: ${error.message}`);
        return res.status(401).json({ok: false, error: error.message});
    }
});

// ── HTTP: ручная отправка дайджеста (для тестирования) ─────────────────────────

app.post('/admin/digest/send', async (req, res) => {
    const secret = process.env.ADMIN_SECRET;
    if (secret && req.headers['x-admin-secret'] !== secret) {
        log.warn('POST /admin/digest/send — forbidden (wrong secret)');
        return res.status(403).json({ok: false, error: 'Forbidden'});
    }

    log.info('POST /admin/digest/send — manual digest triggered');
    try {
        const result = await runDigest(bot, WEBAPP_URL);
        log.info(`POST /admin/digest/send — done: sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`);
        return res.json({ok: true, ...result});
    } catch (err) {
        log.error(`POST /admin/digest/send — error: ${err.message}`, err);
        return res.status(500).json({ok: false, error: err.message});
    }
});

// ── HTTP: предпросмотр дайджеста для конкретного пользователя ─────────────────

app.get('/admin/digest/preview/:telegramId', async (req, res) => {
    const secret = process.env.ADMIN_SECRET;
    if (secret && req.headers['x-admin-secret'] !== secret) {
        return res.status(403).json({ok: false, error: 'Forbidden'});
    }

    try {
        const stats = getCachedStats();
        const sub = getSubscriber(Number(req.params.telegramId));
        const text = buildDigestText(sub?.first_name || 'Тест', stats);
        return res.json({ok: true, text: text || '(нет данных для дайджеста)'});
    } catch (err) {
        return res.status(500).json({ok: false, error: err.message});
    }
});

app.get('/health', (_req, res) => {
    try {
        const cache = getDigestCache();
        const subscribers = getAllActiveSubscribers();
        const now = Math.floor(Date.now() / 1000);
        const cacheInfo = cache
            ? {
                fetched_at:  new Date(cache.fetched_at * 1000).toISOString(),
                age_minutes: Math.round((now - cache.fetched_at) / 60),
                stale:       (now - cache.fetched_at) > 25 * 3600,
              }
            : null;
        return res.json({
            ok:          true,
            uptime_sec:  Math.floor(process.uptime()),
            subscribers: subscribers.length,
            digest_cache: cacheInfo,
        });
    } catch (err) {
        return res.status(500).json({ok: false, error: err.message});
    }
});

// ── Запуск ─────────────────────────────────────────────────────────────────────

async function start() {
    log.info(`Starting bot... PORT=${PORT} WEBAPP_URL=${WEBAPP_URL}`);

    // Подключаем нотификатор для шедулера
    setAdminNotifier((lines) => notifyAdmin(lines));

    await bot.launch();
    log.info('Bot started polling');
    initScheduler(bot, WEBAPP_URL);
    app.listen(PORT, () => log.info(`HTTP server listening on port ${PORT}`));
}

bot.catch((err) => log.error('Telegraf error', err));

start().catch((err) => {
    log.error('Failed to start bot', err);
    process.exit(1);
});

process.once('SIGINT',  () => { log.info('Received SIGINT, stopping...'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { log.info('Received SIGTERM, stopping...'); bot.stop('SIGTERM'); });
