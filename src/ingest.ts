// ingest.ts — pure logic for the Samsung Health HTTP ingest.
//
// A phone automation POSTs the day's totals (steps, water in gallons, meditation
// minutes). When a value clears its goal, the matching habit is auto-checked-off
// via store.checkOff — the same idempotent path the Audible poller uses, so
// repeated pushes the same day never double-count. This module has no Discord or
// http dependency, so it's easy to unit-test; index.ts wires it to a listener.

import { findHabit } from "./habits";
import * as store from "./store";
import type { HealthState } from "./store";

export type Metric = "steps" | "water" | "meditation";

// Static config per metric: which habit it checks off, where its value lives in
// the persisted HealthState, its display unit, and its goal env var + default.
const METRICS: Record<
  Metric,
  {
    habitId: string;
    field: "steps" | "waterGallons" | "meditationMinutes";
    unit: string;
    goalEnv: string;
    defaultGoal: number;
  }
> = {
  steps: { habitId: "steps", field: "steps", unit: "steps", goalEnv: "STEPS_GOAL", defaultGoal: 10000 },
  water: { habitId: "water", field: "waterGallons", unit: "gal", goalEnv: "WATER_GOAL_GALLONS", defaultGoal: 1 },
  meditation: {
    habitId: "meditate",
    field: "meditationMinutes",
    unit: "min",
    goalEnv: "MEDITATION_MINUTES",
    defaultGoal: 1, // "any logged session" ⇒ ≥ 1 minute
  },
};

const ALL_METRICS = Object.keys(METRICS) as Metric[];

// A metric's goal, from its env var (positive finite number) or the default.
export const getGoal = (metric: Metric): number => {
  const cfg = METRICS[metric];
  const n = Number(process.env[cfg.goalEnv]);
  return Number.isFinite(n) && n > 0 ? n : cfg.defaultGoal;
};

// ---------- payload parsing ----------

export interface IngestValues {
  steps?: number;
  water?: number;
  meditation?: number;
}

// Accept a number, or a numeric string; reject anything non-finite or negative.
const coerce = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// Validate an already-JSON-parsed body into the three known numeric fields,
// silently dropping anything missing or malformed.
export const parsePayload = (body: unknown): IngestValues => {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: IngestValues = {};
  const steps = coerce(b.steps);
  if (steps !== undefined) out.steps = steps;
  const water = coerce(b.water);
  if (water !== undefined) out.water = water;
  const meditation = coerce(b.meditation);
  if (meditation !== undefined) out.meditation = meditation;
  return out;
};

export const isEmpty = (v: IngestValues): boolean =>
  v.steps === undefined && v.water === undefined && v.meditation === undefined;

const valueOf = (v: IngestValues, m: Metric): number | undefined =>
  m === "steps" ? v.steps : m === "water" ? v.water : v.meditation;

// ---------- ingest + status ----------

export interface MetricResult {
  metric: Metric;
  habitId: string;
  name: string;
  emoji: string;
  valueToday: number;
  goal: number;
  unit: string;
  met: boolean;
  checkedOff: boolean; // transition to done on this push (announce once)
  done: boolean; // complete today by any means
  currentStreak: number;
}

// Evaluate one metric's pushed value: persist nothing here (caller already saved
// the snapshot), compare to goal, and check the habit off if met.
const evaluate = (metric: Metric, value: number, tz: string): MetricResult => {
  const cfg = METRICS[metric];
  const habit = findHabit(cfg.habitId);
  const goal = getGoal(metric);
  const met = goal > 0 && value >= goal;

  const base = {
    metric,
    habitId: cfg.habitId,
    name: habit?.name ?? cfg.habitId,
    emoji: habit?.emoji ?? "",
    valueToday: value,
    goal,
    unit: cfg.unit,
    met,
  };

  if (met) {
    const res = store.checkOff(cfg.habitId, tz);
    return { ...base, checkedOff: !res.alreadyDone, done: true, currentStreak: res.currentStreak };
  }

  const hs = store.load().habits[cfg.habitId];
  return {
    ...base,
    checkedOff: false,
    done: hs?.lastCompletedDate === store.todayStr(tz),
    currentStreak: hs?.currentStreak ?? 0,
  };
};

// Persist the pushed values as today's snapshot, then evaluate each provided
// metric. Returns one result per metric present in the payload.
export const handleIngest = (values: IngestValues, tz: string): MetricResult[] => {
  const snapshot: Omit<HealthState, "date"> = {};
  if (values.steps !== undefined) snapshot.steps = values.steps;
  if (values.water !== undefined) snapshot.waterGallons = values.water;
  if (values.meditation !== undefined) snapshot.meditationMinutes = values.meditation;
  store.setHealth(snapshot, tz);

  const results: MetricResult[] = [];
  for (const metric of ALL_METRICS) {
    const value = valueOf(values, metric);
    if (value !== undefined) results.push(evaluate(metric, value, tz));
  }
  return results;
};

export interface MetricStatus {
  metric: Metric;
  habitId: string;
  name: string;
  emoji: string;
  valueToday: number;
  goal: number;
  unit: string;
  done: boolean;
  currentStreak: number;
}

export interface TodayStatus {
  date: string;
  metrics: MetricStatus[];
}

// Today's progress for all three metrics — backs GET /status. Reads the last
// pushed values (0 if nothing reported today) plus each habit's done/streak.
export const buildTodayStatus = (tz: string): TodayStatus => {
  const health = store.getHealth(tz);
  const state = store.load();
  const today = store.todayStr(tz);

  const metrics: MetricStatus[] = ALL_METRICS.map((metric) => {
    const cfg = METRICS[metric];
    const habit = findHabit(cfg.habitId);
    const hs = state.habits[cfg.habitId];
    return {
      metric,
      habitId: cfg.habitId,
      name: habit?.name ?? cfg.habitId,
      emoji: habit?.emoji ?? "",
      valueToday: (health[cfg.field] as number | undefined) ?? 0,
      goal: getGoal(metric),
      unit: cfg.unit,
      done: hs?.lastCompletedDate === today,
      currentStreak: hs?.currentStreak ?? 0,
    };
  });

  return { date: today, metrics };
};
