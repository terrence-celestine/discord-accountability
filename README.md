# Discord Accountability Bot

A little accountability partner for your Discord server. Each day at noon it posts a check-in
that @-mentions you, and at 7pm it sends a follow-up nudge **only if you haven't finished the
whole list**. When you reply with what you did ("drank my water and prayed"), it recognizes
each habit by keyword, checks it off for the day, and tracks a **streak per habit**.

- **Multiple named habits**, each with its own streak (edit `src/habits.ts`).
- **Keyword detection** with a basic negation guard ("didn't go to the gym" won't count).
- **Persistent** — streaks are saved to `state.json` and survive restarts/redeploys.
- Written in **TypeScript** (compiled to `dist/` with `tsc`).

## How it works

Reading your replies requires a real bot (a live gateway connection with the **Message
Content Intent**), not just a webhook. So this is a small always-on `discord.js` process:
`node-cron` fires the daily prompt, and a `messageCreate` handler processes your replies.

| File | What it is |
|------|------------|
| `src/index.ts` | Bot: intents, daily cron prompt + evening nudge, reply handler. |
| `src/habits.ts` | Your habit list (name + keywords). **Edit this.** |
| `src/store.ts` | Streak state + math, saved to `state.json`. |
| `tsconfig.json` | TypeScript compiler config (`src/` → `dist/`). |
| `railway.json` | Railway deploy config (always-on service). |
| `.env.example` | The env vars you need to set. |

## 1. Create the bot (Discord Developer Portal)

1. Go to <https://discord.com/developers/applications> → **New Application**, name it.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN` (keep it secret).
3. On the same Bot tab, under **Privileged Gateway Intents**, turn ON **Message Content
   Intent**. (Without this the bot can't read your replies.)

## 2. Invite it to your server

1. **OAuth2 → URL Generator**: check scope **`bot`**.
2. Under Bot Permissions check: **Send Messages**, **Read Message History**, **Add Reactions**.
3. Open the generated URL, pick your server, authorize.

## 3. Grab the IDs

Enable Developer Mode: **User Settings → Advanced → Developer Mode**. Then:

- Right-click the channel you want → **Copy Channel ID** → `CHANNEL_ID`.
- Right-click your own name → **Copy User ID** → `USER_ID`.

## 4. Configure your habits

Edit `src/habits.ts` — set your real habits and the keywords that should check each one off.
Don't change a habit's `id` after streaks start accumulating (the `id` is the storage key).

## 5. Run it locally (to test)

```bash
cd discord-accountability
npm install
cp .env.example .env      # then fill in the values; set DATA_DIR=./data for local
```

Set `SEND_NOW=1` in `.env` if you want it to fire one check-in immediately, then:

```bash
npm run dev               # compiles TypeScript, then runs the bot with .env loaded
```

Reply in the channel ("drank my water and prayed") and watch it react ✅ and report your
streak. `./data/state.json` will show the saved streak.

Other scripts: `npm run build` (compile only), `npm run typecheck` (type-check without
emitting), `npm start` (run the already-compiled `dist/`, used by Railway).

## 6. Deploy to Railway (always-on)

1. Install the CLI and log in: `npm i -g @railway/cli && railway login`.
2. From this folder: `railway init` then `railway up` (deploys the local folder — no GitHub
   needed).
3. **Add a Volume** (Service → Settings → Volumes) mounted at **`/data`** so streaks persist
   across deploys.
4. **Variables** (Service → Variables): set `DISCORD_TOKEN`, `CHANNEL_ID`, `USER_ID`, `TZ`,
   `DAILY_TIME`, `REMINDER_TIME`, and `DATA_DIR=/data`. (Leave `SEND_NOW` unset in production.)

Railway auto-detects the `build` script, so it runs `npm run build` (compiles TypeScript)
and then `npm start` (`node dist/index.js`) — no extra config needed.

That's it — the bot stays online and pings you every day at `DAILY_TIME` in your `TZ`.

## Notes

- Reply again the same day and it won't double-count ("already checked off").
- Miss a day and the streak resets to 1 on your next check-in; the daily prompt shows a
  streak as broken once a full day is missed.
- The bot only reacts to **your** user ID in the **configured channel** — it ignores everyone
  else and other channels.
