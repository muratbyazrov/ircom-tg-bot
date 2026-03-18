require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = Number(process.env.PORT || 3000);
const START_BUTTON_TEXT = 'Запустить';

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  throw new Error('Set BOT_TOKEN, ADMIN_CHAT_ID and WEBAPP_URL in .env');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

function isTelegramDeepLink(url) {
  return /^https:\/\/t\.me\//i.test(url);
}

function buildStartMessage() {
  return [
    'Добро пожаловать в <b>ircom</b>!',
    'Приложение для Цхинвала, где все важное под рукой.',
    `Нажмите кнопку <b>«${START_BUTTON_TEXT}»</b>, чтобы перейти в приложение.`
  ].join('\n\n');
}

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    throw new Error('hash is missing in initData');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');

  if (expectedHash !== hash) {
    throw new Error('invalid initData hash');
  }

  return Object.fromEntries(params.entries());
}

async function notifyAdminFromInitData(rawInitData) {
  const data = parseInitData(rawInitData);
  const user = data.user ? JSON.parse(data.user) : null;

  const lines = [
    '🚀 Кто-то открыл Mini App',
    '',
    `id: ${user?.id ?? 'n/a'}`,
    `username: @${user?.username ?? 'n/a'}`,
    `name: ${[user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'n/a'}`,
    `language_code: ${user?.language_code ?? 'n/a'}`,
    `is_premium: ${user?.is_premium ? 'yes' : 'no'}`,
    `auth_date: ${data.auth_date ?? 'n/a'}`,
    `query_id: ${data.query_id ?? 'n/a'}`,
    `chat_type: ${data.chat_type ?? 'n/a'}`,
    `chat_instance: ${data.chat_instance ?? 'n/a'}`,
    `start_param: ${data.start_param ?? 'n/a'}`
  ];

  await bot.telegram.sendMessage(ADMIN_CHAT_ID, lines.join('\n'));
  return user;
}

async function notifyAdminAboutStart(user) {
  const lines = [
    '▶️ Нажали /start в боте',
    `id: ${user?.id ?? 'n/a'}`,
    `username: @${user?.username ?? 'n/a'}`,
    `name: ${[user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'n/a'}`,
    `language_code: ${user?.language_code ?? 'n/a'}`
  ];
  await bot.telegram.sendMessage(ADMIN_CHAT_ID, lines.join('\n'));
}

bot.start(async (ctx) => {
  const button = isTelegramDeepLink(WEBAPP_URL)
    ? Markup.inlineKeyboard([Markup.button.url(START_BUTTON_TEXT, WEBAPP_URL)])
    : Markup.keyboard([[Markup.button.webApp(START_BUTTON_TEXT, WEBAPP_URL)]]).resize();

  try {
    await notifyAdminAboutStart(ctx.from);
  } catch (error) {
    console.error('Failed to notify admin on /start:', error.message);
    await ctx.reply(
      'Не смог отправить уведомление админу. Проверь ADMIN_CHAT_ID и что админ открыл чат с ботом.'
    );
  }

  await ctx.replyWithHTML(
    buildStartMessage(),
    button
  );
});

// Если Mini App отправляет данные через Telegram.WebApp.sendData(...)
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;

  if (msg?.web_app_data) {
    const from = msg.from || {};
    const payload = msg.web_app_data.data;

    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      [
        '📩 Mini App sendData()',
        `id: ${from.id ?? 'n/a'}`,
        `username: @${from.username ?? 'n/a'}`,
        `name: ${[from.first_name, from.last_name].filter(Boolean).join(' ') || 'n/a'}`,
        `payload: ${payload}`
      ].join('\n')
    );

    await ctx.reply('Данные из Mini App получены.');
    return;
  }

  return next();
});

// Endpoint, который Mini App дергает при открытии
app.post('/webapp/open', async (req, res) => {
  try {
    const initData = req.body?.initData;
    if (!initData) {
      return res.status(400).json({ ok: false, error: 'initData is required' });
    }

    const user = await notifyAdminFromInitData(initData);
    return res.json({ ok: true, user_id: user?.id ?? null });
  } catch (error) {
    return res.status(401).json({ ok: false, error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

async function start() {
  await bot.launch();
  app.listen(PORT, () => {
    console.log(`HTTP server: http://localhost:${PORT}`);
  });
  console.log('Bot started');
}

bot.catch((err) => {
  console.error('Telegraf error:', err);
});

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
