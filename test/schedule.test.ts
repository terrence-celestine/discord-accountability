// Scheduling helper + message builders.
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";
import { timeToCron, remainingHabits, buildReminder, buildDailyPrompt, buildSummary, buildHelp, matchedHabits, BotMessage } from "../src/logic";
import { habits } from "../src/habits";

const TZ = "America/Los_Angeles";
let today: string;

// Flatten a card's title + description + every field into one searchable string,
// so the builder tests can assert on visible text regardless of embed layout.
const cardText = (m: BotMessage): string => {
  const e = m.embeds[0].data;
  return [
    e.title,
    e.description,
    ...(e.fields ?? []).flatMap((f) => [f.name, f.value]),
  ]
    .filter(Boolean)
    .join("\n");
};

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-sched-"));
  today = store.todayStr(TZ);
});

beforeEach(() => store.save({ habits: {} }));

test("timeToCron converts HH:MM to a daily cron expression", () => {
  expect(timeToCron("12:00")).toBe("0 12 * * *");
  expect(timeToCron("19:00")).toBe("0 19 * * *");
  expect(timeToCron("09:05")).toBe("5 9 * * *");
  expect(timeToCron("21:30")).toBe("30 21 * * *");
});

test("timeToCron throws on malformed or out-of-range input", () => {
  expect(() => timeToCron("noon")).toThrow(RangeError);
  expect(() => timeToCron("25:00")).toThrow(RangeError);
  expect(() => timeToCron("12:99")).toThrow(RangeError);
});

test("remainingHabits returns all habits when none are done", () => {
  expect(remainingHabits(TZ).length).toBe(habits.length);
});

test("remainingHabits excludes habits completed today", () => {
  const done: Record<string, { currentStreak: number; longestStreak: number; lastCompletedDate: string }> = {};
  for (const h of habits) {
    if (h.id !== "steps" && h.id !== "walk_dog") {
      done[h.id] = { currentStreak: 1, longestStreak: 1, lastCompletedDate: today };
    }
  }
  store.save({ habits: done });
  expect(remainingHabits(TZ).map((h) => h.id)).toEqual(["walk_dog", "steps"]);
});

test("remainingHabits ignores completions from a previous day", () => {
  const stale: Record<string, { currentStreak: number; longestStreak: number; lastCompletedDate: string }> = {};
  for (const h of habits) {
    stale[h.id] = { currentStreak: 1, longestStreak: 1, lastCompletedDate: "2000-01-01" };
  }
  store.save({ habits: stale });
  expect(remainingHabits(TZ).length).toBe(habits.length);
});

test("buildReminder lists the remaining habits and mentions the user", () => {
  const remaining = habits.filter((h) => h.id === "steps" || h.id === "walk_dog");
  const msg = buildReminder("u1", remaining);
  expect(msg.content).toMatch(/<@u1>/); // the ping lives in content, not the embed
  const text = cardText(msg);
  expect(text).toMatch(/2 left/);
  expect(text).toContain("Walk dog");
  expect(text).toContain("Hit 10k steps");
});

test("buildDailyPrompt mentions the user and lists every habit", () => {
  const msg = buildDailyPrompt("u1", TZ);
  expect(msg.content).toMatch(/<@u1>/);
  const text = cardText(msg);
  expect(text).toMatch(/Daily Check-In/i);
  for (const h of habits) {
    expect(text).toContain(h.name);
  }
});

test("every habit defines a non-empty emoji", () => {
  for (const h of habits) {
    expect(h.emoji.length).toBeGreaterThan(0);
  }
});

test("buildSummary splits habits into done (with streaks) and left, showing emojis", () => {
  store.save({
    habits: {
      water: { currentStreak: 3, longestStreak: 3, lastCompletedDate: today },
      pray: { currentStreak: 1, longestStreak: 1, lastCompletedDate: today },
    },
  });
  const text = cardText(buildSummary(TZ));
  expect(text).toMatch(new RegExp(`2/${habits.length}`));
  expect(text).toContain("✅ Done");
  expect(text).toContain("💧 Drink 1 gallon of water (🔥 3)");
  expect(text).toContain("🙏 Pray (🔥 1)");
  expect(text).toMatch(new RegExp(`Left \\(${habits.length - 2}\\)`));
  expect(text).toContain("📖 Read for 30 minutes"); // an untouched habit shows under Left
});

test("buildSummary celebrates when everything is done", () => {
  const all: Record<string, { currentStreak: number; longestStreak: number; lastCompletedDate: string }> = {};
  for (const h of habits) all[h.id] = { currentStreak: 1, longestStreak: 1, lastCompletedDate: today };
  store.save({ habits: all });
  const text = cardText(buildSummary(TZ));
  expect(text).toMatch(new RegExp(`${habits.length}/${habits.length}`));
  expect(text).toMatch(/Everything's done/);
});

test("buildSummary with nothing done shows 0 and all habits left", () => {
  const text = cardText(buildSummary(TZ));
  expect(text).toMatch(new RegExp(`0/${habits.length}`));
  expect(text).toMatch(new RegExp(`Left \\(${habits.length}\\)`));
});

test("buildHelp lists the commands and the configured schedule times", () => {
  const text = cardText(buildHelp("12:00", "19:00"));
  expect(text).toMatch(/summary.*status/);
  expect(text).toContain("undo <habit>");
  expect(text).toContain("audible");
  expect(text).toContain("help");
  expect(text).toContain("12:00");
  expect(text).toContain("19:00");
});

test("matchedHabits resolves a multi-habit undo argument", () => {
  expect(matchedHabits("water and pray").map((h) => h.id)).toEqual(["water", "pray"]);
});
