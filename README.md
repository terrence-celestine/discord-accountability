# Discord Accountability Bot

A little accountability partner for your Discord server. Your habits are grouped into three
**time slots** — morning, afternoon, evening — and each slot gets its own check-in that
@-mentions you (7am, noon, and 5pm by default). Later in the evening it sends a follow-up
nudge **only if you haven't finished the whole list**. When you reply with what you did
("drank my water and prayed"), it recognizes each habit by keyword, checks it off for the day,
and tracks a **streak per habit**.

- **Three daily check-ins** — morning / afternoon / evening, each listing only that slot's habits.
- **Multiple named habits**, each with its own streak and time slot (edit `src/habits.ts`).
- **Keyword detection** with a basic negation guard ("didn't shower" won't count).
- **Persistent** — streaks are saved to `state.json` and survive restarts/redeploys.
- **Chat commands** — `summary` / `status` (today's progress), `add_habit <name>` (track a
  custom habit), `undo <habit>` (reverse an accidental check-off), and `help` (list the commands).
- **Audible auto-check-off** (optional) — the Reading habit checks itself off once you've
  listened ≥30 min on Audible that day. See [Audible integration](#audible-integration-optional).
- Written in **TypeScript** (compiled to `dist/` with `tsc`).

## How it works

Reading your replies requires a real bot (a live gateway connection with the **Message
Content Intent**), not just a webhook. So this is a small always-on `discord.js` process:
`node-cron` fires the daily prompt, and a `messageCreate` handler processes your replies.

| File | What it is |
|------|------------|
| `src/index.ts` | Discord wiring: intents, daily cron prompt + evening nudge, reply handler. |
| `src/logic.ts` | Pure logic (keyword matching, streak formatting, cron parsing) — no Discord, easy to test. |
| `src/habits.ts` | Your habit list (name + emoji + time slot + keywords). **Edit this.** |
| `src/store.ts` | Streak state + math, saved to `state.json`. |
| `src/audible.ts` | Optional Audible integration: derives minutes listened, auto-checks off Reading. |
| `src/audible-setup.ts` | One-time local login (`npm run setup:audible`) to generate Audible credentials. |
| `test/` | Vitest suite (`*.test.ts`) covering `logic.ts`, `store.ts`, and `audible.ts`. |
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
Every habit needs a `slot` of `"morning"`, `"afternoon"`, or `"evening"`, which decides which
check-in it shows up in. Don't change a habit's `id` after streaks start accumulating (the `id`
is the storage key).

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

Other scripts: `npm run build` (compile only), `npm run typecheck` (type-check `src/` + tests),
`npm start` (run the already-compiled `dist/`, used by Railway).

### Tests

```bash
npm test          # run once
npm run test:watch  # re-run on change
```

Tests are written in TypeScript and run with **Vitest**, importing the source in `src/`
directly. They cover streak math (continue / reset / no double-count / broken), persistence,
keyword matching + the negation guard, the daily/evening message builders, and cron-time
parsing. Each test file uses its own temp `DATA_DIR`, so they never touch your real
`state.json`.

## Audible integration (optional)

The Reading habit can check itself off automatically based on real Audible listening time.
It's fully optional — leave `AUDIBLE_CREDENTIALS` unset and the bot ignores it entirely.

**How it works:** the bot polls your Audible library hourly via
[`audible-api-ts`](https://www.npmjs.com/package/audible-api-ts), derives your total minutes
listened (Σ book length × percent complete), diffs it against a daily baseline to get
"minutes listened today," and once that clears `READING_MINUTES` (default 30) it checks off
`reading`. Uses the private Audible API (an unofficial, ToS-gray-area, may-break integration).

**One-time setup (run locally — it needs your Amazon login):**

```bash
npm run setup:audible
```

It prints an Amazon login URL; sign in, then paste back the redirect URL (the one containing
`openid.oa2.authorization_code`). It saves credentials to `DATA_DIR/audible-credentials.json`
and prints a listening-time sanity check so you can confirm the numbers look right.

**For Railway:** copy the saved credentials JSON into the **`AUDIBLE_CREDENTIALS`** variable
(one line). On first boot the bot writes it to the `/data` volume and **auto-refreshes the
tokens from then on** — no recurring re-login. Optionally set `AUDIBLE_LOCALE` (default `com`)
and `READING_MINUTES` (default `30`).

## 6. Deploy to Railway (always-on)

Railway deploys straight from GitHub and redeploys on every push.

1. Push this repo to GitHub (the repo root should be this project — `package.json` at the top).
2. On <https://railway.app>: **New Project → Deploy from GitHub repo** → pick the repo. The
   first deploy will crash until you set the variables below — that's expected.
3. **Add a Volume** (service → Settings → Volumes) mounted at **`/data`** so streaks persist
   across deploys.
4. **Variables** (service → Variables): set `DISCORD_TOKEN`, `CHANNEL_ID`, `USER_ID`, `TZ`,
   `MORNING_TIME`, `AFTERNOON_TIME`, `EVENING_TIME`, `REMINDER_TIME`, and `DATA_DIR=/data`.
   (Leave `SEND_NOW` unset in production.)

Build and start are driven by `railway.json`: it runs `npm run build` (compiles `src/` →
`dist/`) and starts with `node dist/index.js`. **The start command must point at
`dist/index.js`, not `index.js`** — the source is TypeScript, so the entrypoint only exists
after the build. This is a background worker with no web server, so no public domain is needed.

That's it — the bot stays online and pings you at each slot's time (`MORNING_TIME`,
`AFTERNOON_TIME`, `EVENING_TIME`) in your `TZ`. Every `git push` to the default branch triggers
a fresh deploy, and the `/data` volume keeps your streaks across deploys.

> Prefer the CLI? `npm i -g @railway/cli && railway login`, then `railway up` from this folder
> deploys without GitHub. You still add the volume and variables in the dashboard.

## Notes

- **Check-off buttons** — each slot check-in (and the `morning`/`afternoon`/`evening` commands)
  renders a tappable button per habit below the message. Tap one to check it off: it turns green
  ✅ and disables, and you get a private streak confirmation. Buttons and text replies both work;
  buttons cap at 25 per message, so anything beyond that is still checkable by text.
- Reply again the same day and it won't double-count ("already checked off").
- Miss a day and the streak resets to 1 on your next check-in; the daily prompt shows a
  streak as broken once a full day is missed.
- The bot only reacts to **your** user ID in the **configured channel** — it ignores everyone
  else and other channels.
- **Commands** (optionally prefixed with `!` or `/`):
  - **`summary`** / **`status`** — on-demand report of today's progress (done habits with their
    streaks, plus what's left).
  - **`morning`** / **`afternoon`** / **`evening`** — what's still left to do in that one time
    slot (plus what's already done there), without the other slots' noise.
  - **`add_habit <slot> <name>`** — start tracking a custom habit in a time slot. The slot
    (`morning` / `afternoon` / `evening`) is **required** and comes first, followed by an optional
    leading emoji (e.g. `add_habit morning 🧴 Moisturize`). Without an emoji it gets a default icon
    (📌). Keywords for checking it off are derived from the name (the whole phrase plus each
    meaningful word), and it joins that slot's check-in, the summary, and the nudge immediately.
    Custom habits are persisted in `DATA_DIR/state.json`.
  - **`undo <habit>`** — reverse today's check-off for a habit (e.g. `undo water`, or
    `undo water and pray` for several). Steps the streak back; leaves your all-time best intact.
  - **`help`** — lists the commands and how check-off works.
