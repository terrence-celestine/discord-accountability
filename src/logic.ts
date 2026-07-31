// logic.ts — pure bot logic, independent of Discord.
//
// Everything here is deterministic given its inputs (plus the on-disk streak
// state via store), so it's easy to unit-test without a gateway connection.
// index.ts imports these and wires them to discord.js events.

import { habits, Habit } from "./habits";
import * as store from "./store";

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
export function matchedHabits(rawContent: string): Habit[] {
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

// ---------- scheduling ----------

// "HH:MM" -> node-cron "M H * * *". Throws on malformed/out-of-range input.
export function timeToCron(hhmm: string): string {
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
}

// ---------- message builders ----------

export function fireEmoji(n: number): string {
  return n > 0 ? `🔥 ${n}` : "no streak yet";
}

export function buildDailyPrompt(userId: string, tz: string): string {
  const state = store.load();
  const lines = habits.map((h) => {
    const eff = store.effectiveStreak(state.habits[h.id], tz);
    const tail = eff > 0 ? `${fireEmoji(eff)} — keep it alive!` : "start a streak today";
    return `• **${h.name}** — ${tail}`;
  });
  return (
    `<@${userId}> ☀️ **Daily check-in** — what did you get done today?\n` +
    `Reply and I'll check things off.\n\n` +
    lines.join("\n")
  );
}

// Habits not yet completed today, in list order.
export function remainingHabits(tz: string): Habit[] {
  const state = store.load();
  const today = store.todayStr(tz);
  return habits.filter((h) => {
    const hs = state.habits[h.id];
    return !hs || hs.lastCompletedDate !== today;
  });
}

export function buildReminder(userId: string, remaining: Habit[]): string {
  const lines = remaining.map((h) => `• ${h.name}`);
  return (
    `<@${userId}> ⏰ **Evening nudge** — ${remaining.length} left to finish today:\n\n` +
    lines.join("\n") +
    `\n\nReply with what you knocked out and I'll check them off. 💪`
  );
}
