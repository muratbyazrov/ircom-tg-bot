# Telegram Bot + Mini App open tracking (Node.js)

## 1) Setup

1. Install deps:

```bash
npm install
```

2. Copy env and fill values:

```bash
cp .env.example .env
```

- `BOT_TOKEN` - token from @BotFather
- `ADMIN_CHAT_ID` - your Telegram numeric id (who receives alerts)
- `WEBAPP_URL` - either direct mini app `https://...` OR telegram deep-link `https://t.me/<bot>/<app>?mode=fullscreen`
- `PORT` - local server port (default 3000)

3. Run:

```bash
npm start
```

## 2) Important about button type

- If `WEBAPP_URL` is direct `https://...`, bot sends keyboard `web_app` button.
- If `WEBAPP_URL` is `https://t.me/...`, bot sends inline URL button (otherwise Telegram returns `BUTTON_URL_INVALID`).

## 3) What this bot does

- `/start` sends button `Запустить` that opens your Mini App.
- `POST /webapp/open` receives `initData` from Mini App and verifies Telegram hash.
- After verification bot sends admin message with user data (id, username, name, language, etc).
- Also supports `Telegram.WebApp.sendData(...)` updates.

## 4) Mini App frontend snippet

Add this in your Mini App page (replace API URL):

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
  const tg = window.Telegram.WebApp;
  tg.ready();

  // Notify backend right after app opens
  fetch('https://your-domain.com/webapp/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: tg.initData })
  }).catch(console.error);

  // Optional: MainButton inside Mini App
  tg.MainButton.setText('Отправить данные');
  tg.MainButton.show();
  tg.MainButton.onClick(() => {
    tg.sendData(JSON.stringify({ event: 'main_button_click', at: Date.now() }));
  });
</script>
```

## 5) Notes

- Without calling backend from Mini App (`/webapp/open`), Telegram does not send an update just because user opened web app button.
- For local testing, use tunnel (ngrok/cloudflared) and set HTTPS URL in BotFather.

## 6) Troubleshooting

- On each `/start` bot now sends admin alert `▶️ Нажали /start в боте`.
- If this alert is not delivered:
  - verify `.env` contains correct `ADMIN_CHAT_ID` (numeric user id),
  - open chat with your bot from that admin account and press `Start`,
  - make sure bot is not blocked by admin account,
  - restart process after changing `.env`.
