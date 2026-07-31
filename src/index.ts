// index.ts — the accountability bot (Discord wiring).
//
// Posts a daily check-in that @-mentions you, then listens for your replies in
// the target channel. When a reply mentions a habit's keyword, that habit is
// checked off for the day and its streak is updated. A later "nudge" fires only
// if the day's list isn't complete. All the decision logic lives in logic.ts.

import cron from "node-cron";
import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";

import {
  matchedHabits,
  fireEmoji,
  timeToCron,
  buildDailyPrompt,
  remainingHabits,
  buildReminder,
  buildSummary,
} from "./logic";
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

// Fail fast at startup if the schedule times are malformed.
const dailyExpr = timeToCron(DAILY_TIME);
const reminderExpr = timeToCron(REMINDER_TIME);

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
    await sendMessage(buildDailyPrompt(USER_ID, TZ));
    console.log(`[${new Date().toISOString()}] Sent daily prompt.`);
  } catch (err) {
    console.error("Failed to send daily prompt:", err);
  }
}

// The evening nudge: only fires if some habits are still incomplete for the day.
async function sendReminderIfIncomplete(): Promise<void> {
  try {
    const remaining = remainingHabits(TZ);
    if (remaining.length === 0) {
      console.log(`[${new Date().toISOString()}] All habits complete — skipping reminder.`);
      return;
    }
    await sendMessage(buildReminder(USER_ID, remaining));
    console.log(`[${new Date().toISOString()}] Sent reminder (${remaining.length} remaining).`);
  } catch (err) {
    console.error("Failed to send reminder:", err);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  cron.schedule(dailyExpr, sendDailyPrompt, { timezone: TZ });
  console.log(`Scheduled daily prompt at ${DAILY_TIME} (${TZ}) — cron "${dailyExpr}"`);

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

  // "summary" / "status" command → report today's progress on demand.
  if (/^[!\/]?(summary|status)$/.test(message.content.trim().toLowerCase())) {
    await message.reply({
      content: buildSummary(TZ),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

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

// Only connect when run directly (production entrypoint), never on import.
if (require.main === module) {
  client.login(DISCORD_TOKEN);
}
