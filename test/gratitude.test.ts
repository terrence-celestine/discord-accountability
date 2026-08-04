// Gratitude journal storage — one editable entry per local day.
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";

const TZ = "America/Los_Angeles";

beforeAll(() => {
  // store reads DATA_DIR per-call, so setting it at runtime is enough.
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-gratitude-"));
});

beforeEach(() => store.save({ habits: {} }));

test("no entry for today returns undefined", () => {
  expect(store.getGratitude(TZ)).toBeUndefined();
});

test("setGratitude saves today's entry and getGratitude reads it back", () => {
  store.setGratitude("grateful for coffee", TZ);
  expect(store.getGratitude(TZ)).toBe("grateful for coffee");
});

test("setGratitude overwrites the same day's entry (one per day)", () => {
  store.setGratitude("first", TZ);
  store.setGratitude("second", TZ);
  expect(store.getGratitude(TZ)).toBe("second");
});

test("getGratitude is scoped per day", () => {
  store.setGratitude("today's entry", TZ);
  const today = store.todayStr(TZ);
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yesterday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
  expect(store.getGratitude(TZ, yesterday)).toBeUndefined();
  expect(store.getGratitude(TZ, today)).toBe("today's entry");
});

test("gratitude entries survive alongside other state", () => {
  store.checkOff("water", TZ);
  store.setGratitude("thankful", TZ);
  const state = store.load();
  expect(state.gratitude).toEqual({ [store.todayStr(TZ)]: "thankful" });
  expect(state.habits.water.currentStreak).toBe(1);
});
