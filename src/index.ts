// index.ts — the accountability bot.
//
// Posts a daily check-in that @-mentions you, then listens for your replies in
// the target channel. When a reply mentions a habit's keyword, that habit is
// checked off for the day and its streak is updated. A later "nudge" fires only
// if the day's list isn't complete.

import cron from "node-cron";
import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";

import { habits, Habit } from "./habits";
import * as store from "./store";

// ---------- config / env ----------

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DISCORD_TOKEN = must("DISCORD_TOKEN");
const CHANNEL_ID = must("CHANNEL_ID");
const USER_ID = must("USER_ID");

const TZ = process.env.TZ ?? "UTC";
const DAILY_TIME = process.env.DAILY_TIME ?? "12:00"; // the main daily check-in
const REMINDER_TIME = process.env.REMINDER_TIME ?? "19:00"; // nudge, only if the list isn't complete
const SEND_NOW = process.env.SEND_NOW; // "1" → fire one prompt immediately at startup (testing)

// "HH:MM" -> node-cron "M H * * *"
function timeToCron(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) {
    console.error(`DAILY_TIME/REMINDER_TIME must look like "09:00", got: ${hhmm}`);
    process.exit(1);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    console.error(`Time out of range: ${hhmm}`);
    process.exit(1);
  }
  return `${minute} ${hour} * * *`;
}

// ---------- keyword matching ----------

const NEGATIONS = [
  "didn't", "didnt", "did not", "don't", "dont", "do not",
  "no", "not", "never", "skip", "skipped", "missed", "without", "haven't", "havent",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Is there a negation word in the short window of text just before `index`?
function negatedBefore(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 25), index);
  return NEGATIONS.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`).test(window));
}

// Return the habits that appear (non-negated, whole-word) in the message text.
function matchedHabits(rawContent: string): Habit[] {
  const text = rawContent.toLowerCase();
  const matched: Habit[] = [];
  for (const habit of habits) {
    const hit = habit.keywords.some((kw) => {
      const re = new RegExp(`\\b${escapeRegExp(kw.toLowerCase())}\\b`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!negatedBefore(text, m.index)) return true; // a genuine, non-negated mention
      }
      return false;
    });
    if (hit) matched.push(habit);
  }
  return matched;
}

// ---------- message builders ----------

function fireEmoji(n: number): string {
  return n > 0 ? `🔥 ${n}` : "no streak yet";
}

function buildDailyPrompt(): string {
  const state = store.load();
  const lines = habits.map((h) => {
    const eff = store.effectiveStreak(state.habits[h.id], TZ);
    const tail = eff > 0 ? `${fireEmoji(eff)} — keep it alive!` : "start a streak today";
    return `• **${h.name}** — ${tail}`;
  });
  return (
    `<@${USER_ID}> ☀️ **Daily check-in** — what did you get done today?\n` +
    `Reply and I'll check things off.\n\n` +
    lines.join("\n")
  );
}

// Habits not yet completed today, in list order.
function remainingHabits(): Habit[] {
  const state = store.load();
  const today = store.todayStr(TZ);
  return habits.filter((h) => {
    const hs = state.habits[h.id];
    return !hs || hs.lastCompletedDate !== today;
  });
}

function buildReminder(remaining: Habit[]): string {
  const lines = remaining.map((h) => `• ${h.name}`);
  return (
    `<@${USER_ID}> ⏰ **Evening nudge** — ${remaining.length} left to finish today:\n\n` +
    lines.join("\n") +
    `\n\nReply with what you knocked out and I'll check them off. 💪`
  );
}

// ---------- discord wiring ----------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — must be enabled in the dev portal
  ],
});

async function sendMessage(content: string): Promise<void> {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${CHANNEL_ID} is not a text channel the bot can post in.`);
  }
  await (channel as TextChannel).send({
    content,
    allowedMentions: { users: [USER_ID] }, // only ping the one user
  });
}

async function sendDailyPrompt(): Promise<void> {
  try {
    await sendMessage(buildDailyPrompt());
    console.log(`[${new Date().toISOString()}] Sent daily prompt.`);
  } catch (err) {
    console.error("Failed to send daily prompt:", err);
  }
}

// The evening nudge: only fires if some habits are still incomplete for the day.
async function sendReminderIfIncomplete(): Promise<void> {
  try {
    const remaining = remainingHabits();
    if (remaining.length === 0) {
      console.log(`[${new Date().toISOString()}] All habits complete — skipping reminder.`);
      return;
    }
    await sendMessage(buildReminder(remaining));
    console.log(`[${new Date().toISOString()}] Sent reminder (${remaining.length} remaining).`);
  } catch (err) {
    console.error("Failed to send reminder:", err);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  const dailyExpr = timeToCron(DAILY_TIME);
  cron.schedule(dailyExpr, sendDailyPrompt, { timezone: TZ });
  console.log(`Scheduled daily prompt at ${DAILY_TIME} (${TZ}) — cron "${dailyExpr}"`);

  const reminderExpr = timeToCron(REMINDER_TIME);
  cron.schedule(reminderExpr, sendReminderIfIncomplete, { timezone: TZ });
  console.log(`Scheduled evening nudge at ${REMINDER_TIME} (${TZ}) — cron "${reminderExpr}"`);

  if (SEND_NOW === "1") {
    console.log("SEND_NOW=1 → sending one prompt now.");
    void sendDailyPrompt();
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  // Only react to the tracked user, in the tracked channel, ignoring bots.
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.id !== USER_ID) return;

  const matched = matchedHabits(message.content);
  if (matched.length === 0) return; // just chatting; stay quiet

  const parts: string[] = [];
  let anyNew = false;
  for (const habit of matched) {
    const res = store.checkOff(habit.id, TZ);
    if (res.alreadyDone) {
      parts.push(`**${habit.name}** already checked off today (${fireEmoji(res.currentStreak)})`);
    } else {
      anyNew = true;
      const best =
        res.currentStreak === res.longestStreak && res.longestStreak > 1 ? " 🏆 personal best!" : "";
      parts.push(`**${habit.name}** ✅ ${fireEmoji(res.currentStreak)} day streak${best}`);
    }
  }

  try {
    await message.react("✅");
  } catch {
    /* reacting is best-effort */
  }
  const lead = anyNew ? "Nice work! " : "";
  await message.reply({
    content: lead + parts.join("\n"),
    allowedMentions: { repliedUser: false },
  });
});

// Only connect when run directly, so tests can import the pure helpers without a gateway.
if (require.main === module) {
  client.login(DISCORD_TOKEN);
}

export { matchedHabits, buildDailyPrompt, buildReminder, remainingHabits, timeToCron };
