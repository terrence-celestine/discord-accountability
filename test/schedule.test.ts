// Scheduling helper + message builders.
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";
import { timeToCron, remainingHabits, buildReminder, buildDailyPrompt, buildSummary, buildHelp, matchedHabits } from "../src/logic";
import { habits } from "../src/habits";

const TZ = "America/Los_Angeles";
let today: string;

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
  expect(msg).toMatch(/<@u1>/);
  expect(msg).toMatch(/2 left/);
  expect(msg).toContain("Walk dog");
  expect(msg).toContain("Hit 10k steps");
});

test("buildDailyPrompt mentions the user and lists every habit", () => {
  const msg = buildDailyPrompt("u1", TZ);
  expect(msg).toMatch(/<@u1>/);
  expect(msg).toMatch(/Daily check-in/);
  for (const h of habits) {
    expect(msg).toContain(h.name);
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
  const msg = buildSummary(TZ);
  expect(msg).toMatch(new RegExp(`2/${habits.length} done`));
  expect(msg).toContain("✅ Done");
  expect(msg).toContain("💧 Drink 1 gallon of water (🔥 3)");
  expect(msg).toContain("🙏 Pray (🔥 1)");
  expect(msg).toMatch(new RegExp(`Left \\(${habits.length - 2}\\)`));
  expect(msg).toContain("📖 Read for 30 minutes"); // an untouched habit shows under Left
});

test("buildSummary celebrates when everything is done", () => {
  const all: Record<string, { currentStreak: number; longestStreak: number; lastCompletedDate: string }> = {};
  for (const h of habits) all[h.id] = { currentStreak: 1, longestStreak: 1, lastCompletedDate: today };
  store.save({ habits: all });
  const msg = buildSummary(TZ);
  expect(msg).toMatch(new RegExp(`${habits.length}/${habits.length} done`));
  expect(msg).toMatch(/Everything's done/);
});

test("buildSummary with nothing done shows 0 and all habits left", () => {
  const msg = buildSummary(TZ);
  expect(msg).toMatch(new RegExp(`0/${habits.length} done`));
  expect(msg).toMatch(new RegExp(`Left \\(${habits.length}\\)`));
});

test("buildHelp lists the commands and the configured schedule times", () => {
  const msg = buildHelp("12:00", "19:00");
  expect(msg).toMatch(/summary.*status/);
  expect(msg).toContain("undo <habit>");
  expect(msg).toContain("audible");
  expect(msg).toContain("help");
  expect(msg).toContain("12:00");
  expect(msg).toContain("19:00");
});

test("matchedHabits resolves a multi-habit undo argument", () => {
  expect(matchedHabits("water and pray").map((h) => h.id)).toEqual(["water", "pray"]);
});
