// Scheduling helper + message builders.
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";
import { timeToCron, remainingHabits, buildReminder, buildDailyPrompt } from "../src/logic";
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
