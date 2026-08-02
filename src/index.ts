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
  buildCategoryPrompt,
  remainingHabits,
  buildReminder,
  buildSummary,
  buildHelp,
  SLOT_INFO,
  card,
  simpleCard,
  COLORS,
  BotMessage,
} from "./logic";
import { addHabitFromInput, SLOTS, TimeSlot } from "./habits";
import * as store from "./store";
import * as audible from "./audible";

// ---------- config / env ----------

const must = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

const DISCORD_TOKEN = must("DISCORD_TOKEN");
const CHANNEL_ID = must("CHANNEL_ID");
const USER_ID = must("USER_ID");

const TZ = process.env.TZ ?? "UTC";

// One scheduled check-in per time slot, each pinging that slot's habits.
const SLOT_TIMES: Record<TimeSlot, string> = {
  morning: process.env.MORNING_TIME ?? "07:00",
  afternoon: process.env.AFTERNOON_TIME ?? "12:00",
  evening: process.env.EVENING_TIME ?? "17:00",
};
const REMINDER_TIME = process.env.REMINDER_TIME ?? "20:00"; // end-of-day nudge, only if the list isn't complete
const SEND_NOW = process.env.SEND_NOW; // "1" → fire one prompt immediately at startup (testing)
const READING_MINUTES = Number(process.env.READING_MINUTES ?? "30"); // Audible threshold for auto-check-off

// Fail fast at startup if any schedule time is malformed.
const slotExprs: Record<TimeSlot, string> = {
  morning: timeToCron(SLOT_TIMES.morning),
  afternoon: timeToCron(SLOT_TIMES.afternoon),
  evening: timeToCron(SLOT_TIMES.evening),
};
const reminderExpr = timeToCron(REMINDER_TIME);

// ---------- discord wiring ----------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — must be enabled in the dev portal
  ],
});

const sendMessage = async (payload: BotMessage): Promise<void> => {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${CHANNEL_ID} is not a text channel the bot can post in.`);
  }
  await (channel as TextChannel).send({
    content: payload.content,
    embeds: payload.embeds,
    allowedMentions: { users: [USER_ID] }, // only ping the one user
  });
};

const sendDailyPrompt = async (): Promise<void> => {
  try {
    await sendMessage(buildDailyPrompt(USER_ID, TZ));
    console.log(`[${new Date().toISOString()}] Sent daily prompt.`);
  } catch (err) {
    console.error("Failed to send daily prompt:", err);
  }
};

// The per-slot check-in (morning / afternoon / evening).
const sendCategoryPrompt = async (slot: TimeSlot): Promise<void> => {
  try {
    await sendMessage(buildCategoryPrompt(USER_ID, TZ, slot));
    console.log(`[${new Date().toISOString()}] Sent ${slot} check-in.`);
  } catch (err) {
    console.error(`Failed to send ${slot} check-in:`, err);
  }
};

// The evening nudge: only fires if some habits are still incomplete for the day.
const sendReminderIfIncomplete = async (): Promise<void> => {
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
};

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  for (const slot of SLOTS) {
    cron.schedule(slotExprs[slot], () => void sendCategoryPrompt(slot), { timezone: TZ });
    console.log(
      `Scheduled ${slot} check-in at ${SLOT_TIMES[slot]} (${TZ}) — cron "${slotExprs[slot]}"`,
    );
  }

  cron.schedule(reminderExpr, sendReminderIfIncomplete, { timezone: TZ });
  console.log(`Scheduled catch-up nudge at ${REMINDER_TIME} (${TZ}) — cron "${reminderExpr}"`);

  // Audible: if credentials are configured, poll hourly to auto-check-off Reading.
  if (audible.isConfigured()) {
    const audibleJob = async (): Promise<void> => {
      try {
        const r = await audible.pollAudible(TZ, READING_MINUTES);
        if (r.checkedOff) {
          await sendMessage(
            simpleCard(
              COLORS.done,
              "🎧 Audible → Reading",
              `Auto-checked off **reading** — ${Math.round(r.minutesToday)} min on Audible today. 🔥 ${r.currentStreak}`,
            ),
          );
          console.log(`[audible] checked off reading (${Math.round(r.minutesToday)} min today).`);
        }
      } catch (err) {
        console.error("[audible] poll failed:", err);
      }
    };
    cron.schedule("0 * * * *", audibleJob, { timezone: TZ }); // top of every hour
    void audibleJob(); // catch up once at startup
    console.log(`Audible integration enabled — polling hourly (threshold ${READING_MINUTES} min).`);
  } else {
    console.log("Audible integration disabled (no credentials).");
  }

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

  const trimmed = message.content.trim();
  const lower = trimmed.toLowerCase();

  // "help" command → explain the bot and list the commands.
  if (/^[!\/]?help$/.test(lower)) {
    await message.reply({
      embeds: buildHelp({
        morning: SLOT_TIMES.morning,
        afternoon: SLOT_TIMES.afternoon,
        evening: SLOT_TIMES.evening,
        reminder: REMINDER_TIME,
      }).embeds,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  // "summary" / "status" command → report today's progress on demand.
  if (/^[!\/]?(summary|status)$/.test(lower)) {
    await message.reply({
      embeds: buildSummary(TZ).embeds,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  // "add_habit <name>" command → create a custom habit. Accepts "/add_habit",
  // "!add_habit", "add habit", or "addhabit", with an optional leading emoji.
  // Must run BEFORE keyword check-off so the habit name in the arg isn't matched.
  const addMatch = /^[!\/]?add[ _]?habit\b(.*)/i.exec(trimmed);
  if (addMatch) {
    const res = addHabitFromInput(addMatch[1]);
    if (!res.ok) {
      await message.reply({
        embeds: simpleCard(COLORS.undo, "➕ Add Habit", res.error!).embeds,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    const h = res.habit!;
    const slotInfo = SLOT_INFO[h.slot];
    const embed = card(COLORS.done, "➕ Habit Added")
      .setDescription(
        `${h.emoji} **${h.name}** is now tracked in your ${slotInfo.emoji} ` +
          `**${slotInfo.label}** check-in (${SLOT_TIMES[h.slot]}).`,
      )
      .addFields({
        name: "✅ Check it off by saying",
        value: h.keywords.map((k) => `\`${k}\``).join(", "),
      });
    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    return;
  }

  // "undo <habit>" command → reverse today's check-off. Must run BEFORE keyword check-off,
  // or "undo water" would match the "water" keyword and check it ON instead.
  const undoMatch = /^[!\/]?undo\b(.*)/i.exec(trimmed);
  if (undoMatch) {
    const arg = undoMatch[1].trim();
    if (!arg) {
      await message.reply({
        embeds: simpleCard(COLORS.undo, "↩️ Undo", "Which habit should I undo? e.g. `undo water`").embeds,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    const targets = matchedHabits(arg);
    if (targets.length === 0) {
      await message.reply({
        embeds: simpleCard(
          COLORS.undo,
          "↩️ Undo",
          "I couldn't tell which habit that is — try `undo <habit keyword>`.",
        ).embeds,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    const lines = targets.map((habit) => {
      const res = store.uncheck(habit.id, TZ);
      if (!res.wasDone) {
        return `${habit.emoji} **${habit.name}** wasn't checked off today.`;
      }
      const streak = res.currentStreak > 0 ? fireEmoji(res.currentStreak) : "no active streak";
      return `${habit.emoji} **${habit.name}** unchecked — ${streak}`;
    });
    const undoEmbed = card(COLORS.undo, "↩️ Undo").setDescription(lines.join("\n"));
    await message.reply({
      embeds: [undoEmbed],
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  // "audible" / "listened" command → check Audible minutes now and check off reading at 30.
  if (/^[!\/]?(audible|listened|listening)$/.test(lower)) {
    if (!audible.isConfigured()) {
      await message.reply({
        embeds: simpleCard(COLORS.audible, "🎧 Audible", "Audible isn't set up — no credentials configured.").embeds,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    if ("sendTyping" in message.channel) await message.channel.sendTyping().catch(() => {});
    try {
      const r = await audible.pollAudible(TZ, READING_MINUTES);
      const mins = Math.round(r.minutesToday);
      let color: number = COLORS.audible;
      let description: string;
      if (r.checkedOff) {
        color = COLORS.done;
        description = `${mins} min on Audible today — **reading checked off!** 🔥 ${r.currentStreak}`;
      } else if (r.done) {
        color = COLORS.done;
        description = `${mins} min on Audible today — reading's already done today. ✅`;
      } else {
        const left = Math.max(0, READING_MINUTES - mins);
        description = `${mins} min on Audible today — ${left} more to hit ${READING_MINUTES}. 📖`;
      }
      await message.reply({
        embeds: simpleCard(color, "🎧 Audible", description).embeds,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.error("[audible] command failed:", err);
      await message.reply({
        embeds: simpleCard(COLORS.audible, "🎧 Audible", "Couldn't reach Audible right now — try again in a bit.").embeds,
        allowedMentions: { repliedUser: false },
      });
    }
    return;
  }

  const matched = matchedHabits(message.content);
  if (matched.length === 0) return; // just chatting; stay quiet

  const parts: string[] = [];
  let anyNew = false;
  for (const habit of matched) {
    const res = store.checkOff(habit.id, TZ);
    if (res.alreadyDone) {
      parts.push(`${habit.emoji} **${habit.name}** (already done today)`);
    } else {
      anyNew = true;
      parts.push(`${habit.emoji} **${habit.name}**`);
    }
  }

  try {
    await message.react("✅");
  } catch {
    /* reacting is best-effort */
  }
  const embed = card(
    anyNew ? COLORS.done : COLORS.summary,
    anyNew ? "✅ Nice work!" : "✅ Already logged",
  ).setDescription(parts.join("\n"));
  await message.reply({
    embeds: [embed],
    allowedMentions: { repliedUser: false },
  });
});

// Only connect when run directly (production entrypoint), never on import.
if (require.main === module) {
  client.login(DISCORD_TOKEN);
}
