// Streak logic + persistence — imports the TypeScript source directly (Vitest transforms it).
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";

const TZ = "America/Los_Angeles";
let today: string;

// Pure calendar arithmetic → YYYY-MM-DD, N days from `today`.
const shift = (days: number): string => {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
};

beforeAll(() => {
  // store reads DATA_DIR per-call, so setting it here (at runtime) is enough.
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-store-"));
  today = store.todayStr(TZ);
});

beforeEach(() => store.save({ habits: {} }));

test("first check-off starts a streak at 1", () => {
  expect(store.checkOff("water", TZ)).toEqual({
    alreadyDone: false,
    currentStreak: 1,
    longestStreak: 1,
  });
});

test("checking off twice the same day does not double-count", () => {
  store.checkOff("water", TZ);
  expect(store.checkOff("water", TZ)).toEqual({
    alreadyDone: true,
    currentStreak: 1,
    longestStreak: 1,
  });
});

test("a completion the day after yesterday continues the streak", () => {
  store.save({ habits: { water: { currentStreak: 3, longestStreak: 5, lastCompletedDate: shift(-1) } } });
  expect(store.checkOff("water", TZ)).toEqual({
    alreadyDone: false,
    currentStreak: 4,
    longestStreak: 5,
  });
});

test("beating the record updates longestStreak", () => {
  store.save({ habits: { water: { currentStreak: 5, longestStreak: 5, lastCompletedDate: shift(-1) } } });
  const res = store.checkOff("water", TZ);
  expect(res.currentStreak).toBe(6);
  expect(res.longestStreak).toBe(6);
});

test("a missed day resets the streak to 1 but keeps the longest", () => {
  store.save({ habits: { water: { currentStreak: 8, longestStreak: 8, lastCompletedDate: shift(-3) } } });
  expect(store.checkOff("water", TZ)).toEqual({
    alreadyDone: false,
    currentStreak: 1,
    longestStreak: 8,
  });
});

test("effectiveStreak: full when completed today or yesterday, broken after a gap", () => {
  expect(store.effectiveStreak({ currentStreak: 4, longestStreak: 4, lastCompletedDate: today }, TZ)).toBe(4);
  expect(store.effectiveStreak({ currentStreak: 4, longestStreak: 4, lastCompletedDate: shift(-1) }, TZ)).toBe(4);
  expect(store.effectiveStreak({ currentStreak: 4, longestStreak: 4, lastCompletedDate: shift(-2) }, TZ)).toBe(0);
  expect(store.effectiveStreak({ currentStreak: 0, longestStreak: 0, lastCompletedDate: null }, TZ)).toBe(0);
  expect(store.effectiveStreak(undefined, TZ)).toBe(0);
});

test("state persists to disk and reloads", () => {
  store.checkOff("pray", TZ);
  expect(fs.existsSync(store.statePath())).toBe(true);
  const reloaded = store.load();
  expect(reloaded.habits.pray.currentStreak).toBe(1);
  expect(reloaded.habits.pray.lastCompletedDate).toBe(today);
});

test("load() returns an empty store when no file exists yet", () => {
  fs.rmSync(store.statePath(), { force: true });
  expect(store.load()).toEqual({ habits: {} });
});

test("uncheck reverses today's check-off and steps the streak back to yesterday", () => {
  store.save({ habits: { water: { currentStreak: 4, longestStreak: 6, lastCompletedDate: shift(-1) } } });
  store.checkOff("water", TZ); // now streak 5, completed today
  expect(store.uncheck("water", TZ)).toEqual({ wasDone: true, currentStreak: 4 });
  const hs = store.load().habits.water;
  expect(hs.currentStreak).toBe(4);
  expect(hs.lastCompletedDate).toBe(shift(-1)); // back to yesterday
  expect(hs.longestStreak).toBe(6); // all-time best untouched
});

test("undoing a streak of 1 clears the completion date", () => {
  store.checkOff("pray", TZ); // first ever → streak 1, completed today
  expect(store.uncheck("pray", TZ)).toEqual({ wasDone: true, currentStreak: 0 });
  expect(store.load().habits.pray.lastCompletedDate).toBe(null);
});

test("uncheck does nothing when the habit wasn't completed today", () => {
  store.save({ habits: { water: { currentStreak: 3, longestStreak: 3, lastCompletedDate: shift(-1) } } });
  expect(store.uncheck("water", TZ)).toEqual({ wasDone: false, currentStreak: 3 });
  expect(store.load().habits.water.lastCompletedDate).toBe(shift(-1)); // unchanged
});

test("uncheck on a never-tracked habit is a no-op", () => {
  expect(store.uncheck("meditate", TZ)).toEqual({ wasDone: false, currentStreak: 0 });
});
