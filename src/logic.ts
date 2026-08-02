// logic.ts — pure bot logic, independent of Discord.
//
// Everything here is deterministic given its inputs (plus the on-disk streak
// state via store), so it's easy to unit-test without a gateway connection.
// index.ts imports these and wires them to discord.js events.

import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from "discord.js";

import { allHabits, habitsInSlot, Habit, TimeSlot } from "./habits";
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
  for (const habit of allHabits()) {
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
  components?: ActionRowBuilder<ButtonBuilder>[];
}

// ---------- check-off buttons ----------
//
// Discord embeds can't hold clickable checkboxes, so each habit gets a real
// button below the message. A button's customId is `check:<habitId>`; the
// InteractionCreate handler in index.ts checks it off. Buttons cap at 5 per row
// and 5 rows (25 total) — plenty for a single slot; anything past that is still
// checkable by text reply.
const BUTTONS_PER_ROW = 5;
const MAX_BUTTON_ROWS = 5;

// Build check-off buttons for a set of habits, reflecting today's done state:
// done habits are disabled green ✅ buttons, the rest are tappable.
export const habitButtons = (
  habitsForSlot: Habit[],
  tz: string,
): ActionRowBuilder<ButtonBuilder>[] => {
  const state = store.load();
  const today = store.todayStr(tz);
  const capped = habitsForSlot.slice(0, BUTTONS_PER_ROW * MAX_BUTTON_ROWS);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < capped.length; i += BUTTONS_PER_ROW) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const h of capped.slice(i, i + BUTTONS_PER_ROW)) {
      const done = state.habits[h.id]?.lastCompletedDate === today;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`check:${h.id}`)
          .setLabel(`${done ? "✅" : h.emoji} ${h.name}`.slice(0, 80))
          .setStyle(done ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(done),
      );
    }
    rows.push(row);
  }
  return rows;
};

// One place for the palette so every card feels like the same product.
export const COLORS = {
  daily: 0xfdb813, // sunrise gold — the morning check-in
  nudge: 0xe67e22, // amber — the evening nudge
  summary: 0x5865f2, // blurple — on-demand status
  done: 0x57f287, // green — a successful check-off
  undo: 0xed4245, // red — an undo
  help: 0x5865f2, // blurple — help
  audible: 0xf29f05, // orange — Audible
  morning: 0xfdb813, // sunrise gold
  afternoon: 0x3ba7d9, // midday blue
  evening: 0x8e5cd9, // dusk purple
} as const;

// How each time slot presents in its check-in card.
export const SLOT_INFO: Record<TimeSlot, { label: string; emoji: string; color: number }> = {
  morning: { label: "Morning", emoji: "🌅", color: COLORS.morning },
  afternoon: { label: "Afternoon", emoji: "🌞", color: COLORS.afternoon },
  evening: { label: "Evening", emoji: "🌙", color: COLORS.evening },
};

const FOOTER = "Accountability bot • one reply can check off several habits";

// Base card: colored bar + emoji title. Callers add description/fields/footer.
export const card = (color: number, title: string): EmbedBuilder =>
  new EmbedBuilder().setColor(color).setTitle(title);

// A minimal one-line card for quick confirmations, errors, and notes.
export const simpleCard = (color: number, title: string, description: string): BotMessage => ({
  embeds: [card(color, title).setDescription(description)],
});

export const fireEmoji = (n: number): string => (n > 0 ? `🔥 ${n}` : "no streak yet");

export interface HelpSchedule {
  morning: string;
  afternoon: string;
  evening: string;
  reminder: string;
}

export const buildHelp = (schedule: HelpSchedule): BotMessage => {
  const embed = card(COLORS.help, "🤖 Accountability Bot — How It Works")
    .setDescription(
      "Reply with what you did and I'll check it off and track a streak per habit — e.g. " +
        '*"drank my water and prayed"*. You can mention several at once. Habits are grouped ' +
        "into **morning**, **afternoon**, and **evening**, each with its own check-in.",
    )
    .addFields(
      {
        name: "📋 Commands",
        value: [
          "• `summary` / `status` — today's progress (done + what's left)",
          "• `morning` / `afternoon` / `evening` — what's left in that slot",
          "• `add_habit <slot> <name>` — track a new habit in a slot, e.g. `add_habit morning 🧴 Moisturize`",
          "• `undo <habit>` — remove today's check-off, e.g. `undo water`",
          "• `audible` — check today's Audible minutes, auto-check reading at 30 min",
          "• `help` — this message",
        ].join("\n"),
      },
      {
        name: "⏰ Schedule",
        value:
          `🌅 Morning at **${schedule.morning}**, 🌞 afternoon at **${schedule.afternoon}**, ` +
          `🌙 evening at **${schedule.evening}** — plus a catch-up nudge at ` +
          `**${schedule.reminder}** if anything's still undone. 🔥`,
      },
    )
    .setFooter({ text: FOOTER });
  return { embeds: [embed] };
};

export const buildDailyPrompt = (userId: string, tz: string): BotMessage => {
  const state = store.load();
  const lines = allHabits().map((h) => {
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

// A per-slot check-in: pings the user and lists just that slot's habits with
// their live streaks. Fired at the slot's scheduled time (morning/afternoon/evening).
export const buildCategoryPrompt = (userId: string, tz: string, slot: TimeSlot): BotMessage => {
  const info = SLOT_INFO[slot];
  const state = store.load();
  const slotHabits = habitsInSlot(slot);

  const embed = card(info.color, `${info.emoji} ${info.label} Check-In`)
    .setDescription(
      slotHabits.length
        ? `Your **${info.label.toLowerCase()}** habits — reply with what you got done.`
        : `No **${info.label.toLowerCase()}** habits yet. Add one with \`add_habit ${slot} <name>\`.`,
    )
    .setFooter({ text: FOOTER });

  if (slotHabits.length) {
    const lines = slotHabits.map((h) => {
      const eff = store.effectiveStreak(state.habits[h.id], tz);
      const tail = eff > 0 ? `${fireEmoji(eff)} — keep it alive!` : "start a streak today";
      return `${h.emoji} **${h.name}** — ${tail}`;
    });
    embed.addFields({ name: `🔥 ${info.label} Habits`, value: lines.join("\n") });
  }

  return {
    content: `<@${userId}>`,
    embeds: [embed],
    components: slotHabits.length ? habitButtons(slotHabits, tz) : undefined,
  };
};

// Habits not yet completed today, in list order.
export const remainingHabits = (tz: string): Habit[] => {
  const state = store.load();
  const today = store.todayStr(tz);
  return allHabits().filter((h) => {
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

  const tracked = allHabits();
  const done: Habit[] = [];
  const left: Habit[] = [];
  for (const h of tracked) {
    const hs = state.habits[h.id];
    if (hs && hs.lastCompletedDate === today) done.push(h);
    else left.push(h);
  }

  const embed = card(COLORS.summary, "📋 Today's Summary")
    .setDescription(`**${done.length}/${tracked.length}** habits done today.`)
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

// On-demand progress for a single time slot: what's still to do (and what's done).
// Backs the `/morning`, `/afternoon`, and `/evening` commands.
export const buildSlotSummary = (tz: string, slot: TimeSlot): BotMessage => {
  const info = SLOT_INFO[slot];
  const state = store.load();
  const today = store.todayStr(tz);

  const slotHabits = habitsInSlot(slot);
  const done: Habit[] = [];
  const left: Habit[] = [];
  for (const h of slotHabits) {
    const hs = state.habits[h.id];
    if (hs && hs.lastCompletedDate === today) done.push(h);
    else left.push(h);
  }

  const embed = card(info.color, `${info.emoji} ${info.label} — What's Left`).setFooter({
    text: FOOTER,
  });

  if (slotHabits.length === 0) {
    embed.setDescription(
      `No **${info.label.toLowerCase()}** habits yet. Add one with \`add_habit ${slot} <name>\`.`,
    );
    return { embeds: [embed] };
  }

  embed.setDescription(`**${done.length}/${slotHabits.length}** ${info.label.toLowerCase()} habits done.`);

  if (left.length) {
    embed.addFields({
      name: `⬜ Left (${left.length})`,
      value: left.map((h) => `${h.emoji} ${h.name}`).join("\n"),
    });
  } else {
    embed.addFields({
      name: "🎉 All done!",
      value: `Your ${info.label.toLowerCase()} habits are all done — nice work!`,
    });
  }

  if (done.length) {
    embed.addFields({
      name: "✅ Done",
      value: done
        .map((h) => `${h.emoji} ${h.name} (🔥 ${state.habits[h.id].currentStreak})`)
        .join("\n"),
    });
  }

  return { embeds: [embed], components: habitButtons(slotHabits, tz) };
};
