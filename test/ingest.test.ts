// Samsung Health HTTP ingest logic (pure — no http, no Discord).
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";
import { parsePayload, isEmpty, handleIngest, buildTodayStatus, getGoal } from "../src/ingest";

const TZ = "America/Los_Angeles";

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-ingest-"));
  // Pin goals so tests don't depend on ambient env.
  process.env.STEPS_GOAL = "10000";
  process.env.WATER_GOAL_GALLONS = "1";
  process.env.MEDITATION_MINUTES = "1";
});

beforeEach(() => store.save({ habits: {} }));

test("parsePayload keeps valid non-negative numbers and drops the rest", () => {
  expect(parsePayload({ steps: 10500, water: 1, meditation: 12 })).toEqual({
    steps: 10500,
    water: 1,
    meditation: 12,
  });
  expect(parsePayload({ steps: "8000" })).toEqual({ steps: 8000 }); // numeric string
  expect(parsePayload({ steps: -5, water: "abc", meditation: null })).toEqual({}); // all invalid
  expect(parsePayload("nope")).toEqual({});
});

test("isEmpty detects a payload with no usable metrics", () => {
  expect(isEmpty(parsePayload({}))).toBe(true);
  expect(isEmpty(parsePayload({ junk: 1 }))).toBe(true);
  expect(isEmpty(parsePayload({ steps: 1 }))).toBe(false);
});

test("getGoal reads env overrides and falls back to defaults", () => {
  expect(getGoal("steps")).toBe(10000);
  process.env.STEPS_GOAL = "8000";
  expect(getGoal("steps")).toBe(8000);
  process.env.STEPS_GOAL = "not-a-number";
  expect(getGoal("steps")).toBe(10000); // default on garbage
  process.env.STEPS_GOAL = "10000"; // restore
});

test("hitting a goal auto-checks the habit off and reports the streak", () => {
  const [steps] = handleIngest({ steps: 10500 }, TZ);
  expect(steps.habitId).toBe("steps");
  expect(steps.met).toBe(true);
  expect(steps.checkedOff).toBe(true);
  expect(steps.done).toBe(true);
  expect(steps.currentStreak).toBe(1);
  // Persisted in the real habit state.
  expect(store.load().habits["steps"].lastCompletedDate).toBe(store.todayStr(TZ));
});

test("a second push the same day is idempotent (checkedOff false, no double-count)", () => {
  handleIngest({ steps: 10500 }, TZ);
  const [again] = handleIngest({ steps: 12000 }, TZ);
  expect(again.met).toBe(true);
  expect(again.checkedOff).toBe(false); // already done today
  expect(again.done).toBe(true);
  expect(again.currentStreak).toBe(1); // still 1, not 2
});

test("a value under goal does not check off", () => {
  const [steps] = handleIngest({ steps: 5000 }, TZ);
  expect(steps.met).toBe(false);
  expect(steps.checkedOff).toBe(false);
  expect(steps.done).toBe(false);
  expect(store.load().habits["steps"]).toBeUndefined();
});

test("water is measured in gallons against a 1-gallon goal", () => {
  expect(handleIngest({ water: 0.75 }, TZ)[0].met).toBe(false);
  store.save({ habits: {} });
  const [water] = handleIngest({ water: 1 }, TZ);
  expect(water.habitId).toBe("water");
  expect(water.met).toBe(true);
  expect(water.checkedOff).toBe(true);
});

test("meditation checks off on any logged session (maps to the 'meditate' habit)", () => {
  const [med] = handleIngest({ meditation: 3 }, TZ);
  expect(med.habitId).toBe("meditate");
  expect(med.met).toBe(true);
  expect(med.checkedOff).toBe(true);
  // Zero minutes is not a session.
  store.save({ habits: {} });
  expect(handleIngest({ meditation: 0 }, TZ)[0].met).toBe(false);
});

test("a partial payload only evaluates the metric it contains", () => {
  const results = handleIngest({ steps: 10500 }, TZ);
  expect(results.map((r) => r.metric)).toEqual(["steps"]);
});

test("a multi-metric payload evaluates each in a stable order", () => {
  const results = handleIngest({ meditation: 12, water: 1, steps: 10500 }, TZ);
  expect(results.map((r) => r.metric)).toEqual(["steps", "water", "meditation"]);
  expect(results.every((r) => r.checkedOff)).toBe(true);
});

test("buildTodayStatus reflects pushed values and done state", () => {
  handleIngest({ steps: 10500, water: 0.5 }, TZ);
  const status = buildTodayStatus(TZ);
  expect(status.date).toBe(store.todayStr(TZ));

  const byMetric = Object.fromEntries(status.metrics.map((m) => [m.metric, m]));
  expect(byMetric.steps.valueToday).toBe(10500);
  expect(byMetric.steps.done).toBe(true);
  expect(byMetric.water.valueToday).toBe(0.5);
  expect(byMetric.water.done).toBe(false);
  expect(byMetric.meditation.valueToday).toBe(0); // never reported
  expect(byMetric.meditation.done).toBe(false);
});

test("the health snapshot resets across days (stale date ⇒ zeroed values)", () => {
  store.save({
    habits: {},
    health: { date: "2000-01-01", steps: 9999, waterGallons: 5, meditationMinutes: 30 },
  });
  const status = buildTodayStatus(TZ);
  for (const m of status.metrics) expect(m.valueToday).toBe(0);
});
