// logic.ts — pure bot logic, independent of Discord.
//
// Everything here is deterministic given its inputs (plus the on-disk streak
// state via store), so it's easy to unit-test without a gateway connection.
// index.ts imports these and wires them to discord.js events.

import { EmbedBuilder } from "discord.js";

import { habits, Habit } from "./habits";
import * as store from "./store";

// ---------- keyword matching ----------

const NEGATIONS = [
  "didn't", "didnt", "did not", "don't", "dont", "do not",
  "no", "not", "never", "skip", "skipped", "missed", "without", "haven't", "havent",
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Is there a negation word in the short window of text just before `index`?
const negatedBefore = (text: string, index: number): boolean => {
  const window = text.slice(Math.max(0, index - 25), index);
  return NEGATIONS.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`).test(window));
};

// Return the habits that appear (non-negated, whole-word) in the message text.
export const matchedHabits = (rawContent: string): Habit[] => {
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
};

// ---------- scheduling ----------

// "HH:MM" -> node-cron "M H * * *". Throws on malformed/out-of-range input.
export const timeToCron = (hhmm: string): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) {
    throw new RangeError(`Invalid time "${hhmm}" — expected HH:MM like "09:00"`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    throw new RangeError(`Time out of range: ${hhmm}`);
  }
  return `${minute} ${hour} * * *`;
};

// ---------- message builders ----------
//
// Every outbound bot message is a Discord embed — a card with a colored accent
// bar, an emoji title, and structured fields (the same look as the deal cards
// other bots post). Builders return a ready-to-send payload: `embeds` carries
// the card, and `content` carries the raw @-mention when we need to actually
// ping the user (mentions written inside an embed don't trigger a notification).

export interface BotMessage {
  content?: string;
  embeds: EmbedBuilder[];
}

// One place for the palette so every card feels like the same product.
export const COLORS = {
  daily: 0xfdb813, // sunrise gold — the morning check-in
  nudge: 0xe67e22, // amber — the evening nudge
  summary: 0x5865f2, // blurple — on-demand status
  done: 0x57f287, // green — a successful check-off
  undo: 0xed4245, // red — an undo
  help: 0x5865f2, // blurple — help
  audible: 0xf29f05, // orange — Audible
} as const;

const FOOTER = "Accountability bot • one reply can check off several habits";

// Base card: colored bar + emoji title. Callers add description/fields/footer.
export const card = (color: number, title: string): EmbedBuilder =>
  new EmbedBuilder().setColor(color).setTitle(title);

// A minimal one-line card for quick confirmations, errors, and notes.
export const simpleCard = (color: number, title: string, description: string): BotMessage => ({
  embeds: [card(color, title).setDescription(description)],
});

export const fireEmoji = (n: number): string => (n > 0 ? `🔥 ${n}` : "no streak yet");

export const buildHelp = (dailyTime: string, reminderTime: string): BotMessage => {
  const embed = card(COLORS.help, "🤖 Accountability Bot — How It Works")
    .setDescription(
      "Reply with what you did and I'll check it off and track a streak per habit — e.g. " +
        '*"drank my water and prayed"*. You can mention several at once.',
    )
    .addFields(
      {
        name: "📋 Commands",
        value: [
          "• `summary` / `status` — today's progress (done + what's left)",
          "• `undo <habit>` — remove today's check-off, e.g. `undo water`",
          "• `audible` — check today's Audible minutes, auto-check reading at 30 min",
          "• `help` — this message",
        ].join("\n"),
      },
      {
        name: "⏰ Schedule",
        value:
          `Daily check-in at **${dailyTime}**, plus an evening nudge at ` +
          `**${reminderTime}** if you're not done. 🔥`,
      },
    )
    .setFooter({ text: FOOTER });
  return { embeds: [embed] };
};

export const buildDailyPrompt = (userId: string, tz: string): BotMessage => {
  const state = store.load();
  const lines = habits.map((h) => {
    const eff = store.effectiveStreak(state.habits[h.id], tz);
    const tail = eff > 0 ? `${fireEmoji(eff)} — keep it alive!` : "start a streak today";
    return `${h.emoji} **${h.name}** — ${tail}`;
  });
  const embed = card(COLORS.daily, "☀️ Daily Check-In")
    .setDescription("What did you get done today? Reply and I'll check things off.")
    .addFields({ name: "🔥 Today's Habits", value: lines.join("\n") })
    .setFooter({ text: FOOTER });
  return { content: `<@${userId}>`, embeds: [embed] };
};

// Habits not yet completed today, in list order.
export const remainingHabits = (tz: string): Habit[] => {
  const state = store.load();
  const today = store.todayStr(tz);
  return habits.filter((h) => {
    const hs = state.habits[h.id];
    return !hs || hs.lastCompletedDate !== today;
  });
};

export const buildReminder = (userId: string, remaining: Habit[]): BotMessage => {
  const embed = card(COLORS.nudge, "⏰ Evening Nudge")
    .setDescription(
      `**${remaining.length} left** to finish today. Reply with what you knocked ` +
        "out and I'll check them off. 💪",
    )
    .addFields({
      name: "⬜ Still to do",
      value: remaining.map((h) => `${h.emoji} ${h.name}`).join("\n"),
    })
    .setFooter({ text: FOOTER });
  return { content: `<@${userId}>`, embeds: [embed] };
};

// On-demand progress report: what's done today (with streaks) and what's left.
export const buildSummary = (tz: string): BotMessage => {
  const state = store.load();
  const today = store.todayStr(tz);

  const done: Habit[] = [];
  const left: Habit[] = [];
  for (const h of habits) {
    const hs = state.habits[h.id];
    if (hs && hs.lastCompletedDate === today) done.push(h);
    else left.push(h);
  }

  const embed = card(COLORS.summary, "📋 Today's Summary")
    .setDescription(`**${done.length}/${habits.length}** habits done today.`)
    .setFooter({ text: FOOTER });

  if (done.length) {
    embed.addFields({
      name: "✅ Done",
      value: done
        .map((h) => `${h.emoji} ${h.name} (🔥 ${state.habits[h.id].currentStreak})`)
        .join("\n"),
    });
  }
  if (left.length) {
    embed.addFields({
      name: `⬜ Left (${left.length})`,
      value: left.map((h) => `${h.emoji} ${h.name}`).join("\n"),
    });
  } else {
    embed.addFields({ name: "🎉 All done!", value: "Everything's done for today — nice work!" });
  }

  return { embeds: [embed] };
};
