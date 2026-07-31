// Pure Audible derivation logic (no network — the ESM client is never loaded here).
import { test, expect } from "vitest";
import { totalListenedMinutes, computeMinutesToday } from "../src/audible";
import type { AudibleState } from "../src/store";

test("totalListenedMinutes sums duration × percent-complete across books", () => {
  const items = [
    { durationMinutes: 600, listeningStatus: { percentComplete: 50 } }, // 300
    { durationMinutes: 120, listeningStatus: { percentComplete: 100 } }, // 120
    { durationMinutes: 300, listeningStatus: { percentComplete: 0 } }, // 0
    { durationMinutes: 90 }, // no status → 0
  ];
  expect(totalListenedMinutes(items)).toBe(420);
});

test("totalListenedMinutes clamps out-of-range percentages", () => {
  const items = [{ durationMinutes: 100, listeningStatus: { percentComplete: 150 } }]; // clamp → 100%
  expect(totalListenedMinutes(items)).toBe(100);
});

test("timeRemainingSeconds gives precise minutes (duration − remaining)", () => {
  const items = [{ durationMinutes: 60, listeningStatus: { timeRemainingSeconds: 900 } }]; // 60 − 15
  expect(totalListenedMinutes(items)).toBe(45);
});

test("timeRemainingSeconds takes precedence over whole-percent progress", () => {
  // percent would say 10 min; the second-precise remaining says 50 min — use the precise one.
  const items = [
    { durationMinutes: 100, listeningStatus: { percentComplete: 10, timeRemainingSeconds: 3000 } },
  ];
  expect(totalListenedMinutes(items)).toBe(50);
});

test("timeRemainingSeconds exceeding duration clamps to 0", () => {
  const items = [{ durationMinutes: 30, listeningStatus: { timeRemainingSeconds: 3600 } }];
  expect(totalListenedMinutes(items)).toBe(0);
});

test("a finished book with no times counts as fully listened", () => {
  const items = [{ durationMinutes: 200, listeningStatus: { isFinished: true } }];
  expect(totalListenedMinutes(items)).toBe(200);
});

const state = (o: Partial<AudibleState>): AudibleState => ({
  baselineDate: null,
  baselineTotal: 0,
  lastTotal: 0,
  ...o,
});

test("first ever run anchors the baseline to now and reports 0 minutes today", () => {
  const { minutesToday, next } = computeMinutesToday(state({}), 1000, "2026-07-30");
  expect(minutesToday).toBe(0);
  expect(next).toEqual({ baselineDate: "2026-07-30", baselineTotal: 1000, lastTotal: 1000 });
});

test("same-day poll reports minutes since the day's baseline", () => {
  const prev = state({ baselineDate: "2026-07-30", baselineTotal: 1000, lastTotal: 1000 });
  const { minutesToday, next } = computeMinutesToday(prev, 1032, "2026-07-30");
  expect(minutesToday).toBe(32);
  expect(next).toEqual({ baselineDate: "2026-07-30", baselineTotal: 1000, lastTotal: 1032 });
});

test("a new day anchors the baseline to yesterday's last total", () => {
  const prev = state({ baselineDate: "2026-07-30", baselineTotal: 1000, lastTotal: 1032 });
  const { minutesToday, next } = computeMinutesToday(prev, 1045, "2026-07-31");
  expect(minutesToday).toBe(13); // 1045 - 1032
  expect(next).toEqual({ baselineDate: "2026-07-31", baselineTotal: 1032, lastTotal: 1045 });
});

test("a dip in total (scrubbing back) clamps minutes today to 0", () => {
  const prev = state({ baselineDate: "2026-07-30", baselineTotal: 1000, lastTotal: 1000 });
  const { minutesToday } = computeMinutesToday(prev, 990, "2026-07-30");
  expect(minutesToday).toBe(0);
});
