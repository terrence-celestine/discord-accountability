# Discord Accountability Bot

A little accountability partner for your Discord server. Your habits are grouped into three
**time slots** — morning, afternoon, evening — and each slot gets its own check-in that
@-mentions you (7am, noon, and 5pm by default). Later in the evening it sends a follow-up
nudge **only if you haven't finished the whole list**. Each check-in has a tappable button per
habit — tap one to check it off for the day, and it tracks a **streak per habit**.

- **Three daily check-ins** — morning / afternoon / evening, each listing only that slot's habits.
- **Multiple named habits**, each with its own streak and time slot (edit `src/habits.ts`).
- **Keyword detection** with a basic negation guard ("didn't shower" won't count).
- **Persistent** — streaks are saved to `state.json` and survive restarts/redeploys.
- **Slash commands** (private replies) — `/summary` (today's progress), `/slot` (one slot's
  progress), `/gratitude` (write today's gratitude entry — see below), `/add-habit` (track a
  custom habit), `/undo` (reverse an accidental check-off), and `/help`. Replies are ephemeral,
  so they never clutter the channel.
- **Gratitude journal** — `/gratitude` opens a modal to write (or edit) one entry per day; saving
  it checks off the built-in `gratitude` habit and earns its streak. A 🙏 button on the evening
  check-in opens the same modal.
- **Audible auto-check-off** (optional) — the Reading habit checks itself off once you've
  listened ≥30 min on Audible that day. See [Audible integration](#audible-integration-optional).
- **Samsung Health ingest** (optional) — push steps/water/meditation over HTTP and the matching
  habits auto-check when you hit the day's goal. See [Samsung Health ingest](#samsung-health-ingest-optional).
- Written in **TypeScript** (compiled to `dist/` with `tsc`).

## How it works

The bot posts scheduled check-ins with tappable buttons and answers slash commands — all through
a live `discord.js` gateway connection. `node-cron` fires the daily prompts; an `InteractionCreate`
router handles button check-offs, slash commands, and the gratitude modal. Because everything the
user does is an interaction (not a chat message), the bot needs **only the Guilds intent** — the
privileged **Message Content Intent can stay OFF**.

| File | What it is |
|------|------------|
| `src/index.ts` | Discord wiring: intents, daily cron prompts + evening nudge, and the interaction router (buttons, slash commands, modals). |
| `src/commands.ts` | Slash-command definitions + guild registration. |
| `src/logic.ts` | Pure logic (streak formatting, cron parsing, message/modal builders) — no gateway, easy to test. |
| `src/habits.ts` | Your habit list (name + emoji + time slot + keywords). **Edit this.** |
| `src/store.ts` | Streak state + math, saved to `state.json`. |
| `src/audible.ts` | Optional Audible integration: derives minutes listened, auto-checks off Reading. |
| `src/audible-setup.ts` | One-time local login (`npm run setup:audible`) to generate Audible credentials. |
| `src/ingest.ts` | Samsung Health ingest logic: maps pushed steps/water/meditation to habit check-offs. |
| `src/http.ts` | The `POST /ingest` + `GET /status` request handler (no Discord dep, unit-tested). |
| `test/` | Vitest suite (`*.test.ts`) covering `logic.ts`, `store.ts`, `audible.ts`, `ingest.ts`, and `http.ts`. |
| `tsconfig.json` | TypeScript compiler config (`src/` → `dist/`). |
| `railway.json` | Railway deploy config (always-on service). |
| `.env.example` | The env vars you need to set. |

## 1. Create the bot (Discord Developer Portal)

1. Go to <https://discord.com/developers/applications> → **New Application**, name it.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN` (keep it secret).
3. **No privileged intents are required.** The bot uses only the Guilds intent, so you can leave
   **Message Content Intent OFF** (check-offs happen via buttons and slash commands, not by reading
   your messages).

## 2. Invite it to your server

1. **OAuth2 → URL Generator**: check scopes **`bot`** and **`applications.commands`** (the second
   is what lets the bot register its slash commands — without it, command registration fails with
   "Missing Access").
2. Under Bot Permissions check: **Send Messages**, **Read Message History**.
3. Open the generated URL, pick your server, authorize.

> Already had the bot in your server before slash commands existed? **Re-invite it** with the
> updated URL (now including `applications.commands`) — same server, it just grants the new scope.

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

Tap a habit's button on the check-in (or run `/summary`) and watch the button turn green ✅ with a
private streak confirmation. `./data/state.json` will show the saved streak. Slash commands appear
in the server once the bot has registered them on startup (needs the `applications.commands` scope).

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

## Samsung Health ingest (optional)

Push your **steps, water, and meditation** into the bot over HTTP and it auto-checks off the
matching habits (`steps`, `water`, `meditate`) when you hit the day's goal — the same way Audible
auto-checks reading, but *pushed* from a phone automation (Bixby routine, Tasker, Health Sync, an
Automate flow, etc.) instead of polled.

It's fully optional: leave **`INGEST_TOKEN`** unset and no server starts. Set it and the bot
exposes two authenticated endpoints plus an unauthenticated health check.

**Endpoints** (both require `Authorization: Bearer <INGEST_TOKEN>`):

- **`POST /ingest`** — body is JSON with any of the three metrics (today's totals):
  ```json
  { "steps": 10500, "water": 1, "meditation": 12 }
  ```
  `water` is in **gallons**, `meditation` in **minutes**. Each metric that meets its goal is
  checked off (idempotently — re-posting the same day won't double-count), and a Discord card is
  posted for anything newly completed. Responds with per-metric results.
- **`GET /status`** — today's progress for all three metrics (value, goal, done, streak) as JSON.
- **`GET /healthz`** — unauthenticated `200 ok`, for platform liveness checks.

**Goals** (env vars, with defaults): `STEPS_GOAL=10000`, `WATER_GOAL_GALLONS=1`,
`MEDITATION_MINUTES=1` (any logged session). Pushed values are treated as **that day's totals**
(they reset daily) and stored per-day so `/status` can show progress.

**Try it locally:** set `INGEST_TOKEN` and `DATA_DIR=./data` in `.env`, `npm run dev`, then:

```bash
curl -s -X POST localhost:3000/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"steps":10500,"water":1,"meditation":12}'
```

**For Railway:** set `INGEST_TOKEN` (a long random secret) in the service Variables, then enable a
public URL under **Service → Settings → Networking → Generate Domain** so your phone can reach it.
Railway injects `PORT` automatically; the bot listens on it. Point your phone automation at
`https://<your-domain>/ingest` with the `Authorization: Bearer` header.

## 6. Deploy to Railway (always-on)

Railway deploys straight from GitHub and redeploys on every push.

1. Push this repo to GitHub (the repo root should be this project — `package.json` at the top).
2. On <https://railway.app>: **New Project → Deploy from GitHub repo** → pick the repo. The
   first deploy will crash until you set the variables below — that's expected.
3. **Add a Volume** (service → Settings → Volumes) mounted at **`/data`** so streaks persist
   across deploys.
4. **Variables** (service → Variables): set `DISCORD_TOKEN`, `CHANNEL_ID`, `USER_ID`, `TZ`,
   `MORNING_TIME`, `AFTERNOON_TIME`, `EVENING_TIME`, `REMINDER_TIME`, and `DATA_DIR=/data`.
   (Leave `SEND_NOW` unset in production.) To enable the Samsung Health endpoints, also set
   `INGEST_TOKEN` (and optionally `STEPS_GOAL` / `WATER_GOAL_GALLONS` / `MEDITATION_MINUTES`) —
   see [Samsung Health ingest](#samsung-health-ingest-optional).

Build and start are driven by `railway.json`: it runs `npm run build` (compiles `src/` →
`dist/`) and starts with `node dist/index.js`. **The start command must point at
`dist/index.js`, not `index.js`** — the source is TypeScript, so the entrypoint only exists
after the build. Without `INGEST_TOKEN` it's a background worker with no web server, so no public
domain is needed; set `INGEST_TOKEN` and it also serves the ingest endpoints (see that section
for the one extra Railway step — enabling a public domain).

That's it — the bot stays online and pings you at each slot's time (`MORNING_TIME`,
`AFTERNOON_TIME`, `EVENING_TIME`) in your `TZ`. Every `git push` to the default branch triggers
a fresh deploy, and the `/data` volume keeps your streaks across deploys.

> Prefer the CLI? `npm i -g @railway/cli && railway login`, then `railway up` from this folder
> deploys without GitHub. You still add the volume and variables in the dashboard.

## Notes

- **Check-off buttons** — each slot check-in (and the evening nudge) renders a tappable button per
  habit below the message. Tap one to check it off: it turns green ✅ and disables, and you get a
  private streak confirmation. Buttons cap at 25 per message.
- Tap again the same day and it won't double-count ("already checked off").
- Miss a day and the streak resets to 1 on your next check-in; the daily prompt shows a
  streak as broken once a full day is missed.
- The bot only accepts interactions from **your** user ID — it politely refuses everyone else.
- **Slash commands** — all reply **ephemerally** (only you see them), so they never clutter the channel:
  - **`/summary`** — today's progress (done habits with their streaks, plus what's left).
  - **`/slot <slot>`** — what's still left in one time slot (plus what's already done there).
  - **`/gratitude`** — opens a modal to write or edit today's gratitude entry. Saving it records the
    entry (one per day, editable) **and** checks off the built-in `gratitude` habit for its streak.
    A 🙏 button on the evening check-in opens the same modal.
  - **`/add-habit <slot> <name> [emoji]`** — start tracking a custom habit in a time slot. The slot
    is a dropdown; `name` is required; `emoji` is optional (defaults to 📌). It joins that slot's
    check-in and the summary immediately and is persisted in `DATA_DIR/state.json`.
  - **`/undo <habit>`** — reverse today's check-off for a habit (e.g. `water`). Steps the streak
    back; leaves your all-time best intact.
  - **`/help`** — lists the commands and how check-off works.
