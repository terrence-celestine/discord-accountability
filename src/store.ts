// store.ts — persistent streak state + streak math.
//
// State lives in a single JSON file on disk (a mounted Railway Volume in prod,
// a local folder in dev). Writes are atomic (temp file + rename) so a crash
// mid-write can't corrupt the file. DATA_DIR is read per-call (not cached at
// import), so tests can point it at a temp directory at runtime.

import fs from "fs";
import path from "path";

import type { Habit } from "./habits"; // type-only — erased at compile, so no runtime import cycle

const dataDir = (): string => process.env.DATA_DIR || "/data";

export const statePath = (): string => path.join(dataDir(), "state.json");

export interface HabitState {
  currentStreak: number;
  longestStreak: number;
  lastCompletedDate: string | null;
}

// Tracks Audible "minutes listened today" via a daily-diffed running total.
export interface AudibleState {
  baselineDate: string | null; // local date the baseline was anchored
  baselineTotal: number; // total listened-minutes at the start of that day
  lastTotal: number; // most recent observed total (used to anchor the next day)
}

// The most recent Samsung Health values pushed for a single local day. Values are
// today's totals (they reset each day), so `date` scopes them — a stale date means
// nothing has been reported yet today.
export interface HealthState {
  date: string | null; // local date these values belong to
  steps?: number;
  waterGallons?: number;
  meditationMinutes?: number;
}

export interface State {
  habits: Record<string, HabitState>;
  audible?: AudibleState;
  health?: HealthState; // latest pushed Samsung Health values for the current day
  customHabits?: Habit[]; // user-defined habits added at runtime via /add-habit
  gratitude?: Record<string, string>; // local day (YYYY-MM-DD) → that day's gratitude entry
  gratitudeMessages?: Record<string, string>; // local day → the journal-channel message id for that day
}

export interface CheckOffResult {
  alreadyDone: boolean;
  currentStreak: number;
  longestStreak: number;
}

export interface UncheckResult {
  wasDone: boolean;
  currentStreak: number;
}

// ---------- date helpers (all "dates" are local calendar days in a timezone) ----------

// Format a Date as YYYY-MM-DD in the given IANA timezone. 'en-CA' yields ISO-ish output.
const localDateStr = (date: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export const todayStr = (tz: string): string => localDateStr(new Date(), tz);

// Pure calendar arithmetic on a YYYY-MM-DD string (timezone-independent).
const addDays = (dateStr: string, delta: number): string => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return localDateStr(dt, "UTC");
};

const daysBetween = (fromStr: string, toStr: string): number => {
  const [ay, am, ad] = fromStr.split("-").map(Number);
  const [by, bm, bd] = toStr.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
};

// ---------- persistence ----------

export const load = (): State => {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!parsed.habits) parsed.habits = {};
    return parsed as State;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { habits: {} };
    throw err;
  }
};

export const save = (state: State): void => {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = statePath();
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target); // atomic on the same filesystem
};

const habitState = (state: State, habitId: string): HabitState => {
  if (!state.habits[habitId]) {
    state.habits[habitId] = {
      currentStreak: 0,
      longestStreak: 0,
      lastCompletedDate: null,
    };
  }
  return state.habits[habitId];
};

// ---------- streak logic ----------

// The streak actually "counts today" only if it was completed today or yesterday.
// If the last completion is older than yesterday, the stored streak is stale/broken.
export const effectiveStreak = (hs: HabitState | undefined, tz: string): number => {
  if (!hs || !hs.lastCompletedDate) return 0;
  const gap = daysBetween(hs.lastCompletedDate, todayStr(tz));
  if (gap <= 1) return hs.currentStreak; // completed today or yesterday
  return 0; // a full day was missed → broken
};

// Check a habit off for today. Returns a summary of what happened.
export const checkOff = (habitId: string, tz: string): CheckOffResult => {
  const state = load();
  const hs = habitState(state, habitId);
  const today = todayStr(tz);

  if (hs.lastCompletedDate === today) {
    return { alreadyDone: true, currentStreak: hs.currentStreak, longestStreak: hs.longestStreak };
  }

  if (hs.lastCompletedDate === addDays(today, -1)) {
    hs.currentStreak += 1; // continued from yesterday
  } else {
    hs.currentStreak = 1; // first ever, or a gap broke the old streak
  }

  hs.lastCompletedDate = today;
  if (hs.currentStreak > hs.longestStreak) hs.longestStreak = hs.currentStreak;

  save(state);
  return { alreadyDone: false, currentStreak: hs.currentStreak, longestStreak: hs.longestStreak };
};

// Reverse today's check-off for a habit (correction tool). Only affects a habit completed
// today. longestStreak (the all-time best) is intentionally left untouched.
export const uncheck = (habitId: string, tz: string): UncheckResult => {
  const state = load();
  const hs = state.habits[habitId];
  const today = todayStr(tz);

  if (!hs || hs.lastCompletedDate !== today) {
    return { wasDone: false, currentStreak: hs ? hs.currentStreak : 0 };
  }

  hs.currentStreak = Math.max(0, hs.currentStreak - 1);
  // A streak of N ending today means yesterday was day N-1; if it drops to 0, no active streak.
  hs.lastCompletedDate = hs.currentStreak > 0 ? addDays(today, -1) : null;

  save(state);
  return { wasDone: true, currentStreak: hs.currentStreak };
};

// ---------- Audible baseline (for deriving minutes listened today) ----------

export const getAudibleState = (): AudibleState => {
  const s = load();
  return s.audible ?? { baselineDate: null, baselineTotal: 0, lastTotal: 0 };
};

export const setAudibleState = (audible: AudibleState): void => {
  const s = load();
  s.audible = audible;
  save(s);
};

// ---------- Samsung Health snapshot (latest pushed values for today) ----------

// Today's pushed values, or empty values if nothing's been reported today yet.
// Anything dated before `tz`'s today is treated as reset (the metrics are daily).
export const getHealth = (tz: string): HealthState => {
  const h = load().health;
  if (!h || h.date !== todayStr(tz)) return { date: todayStr(tz) };
  return h;
};

// Merge new values into today's snapshot (partial pushes are fine), stamped with today.
export const setHealth = (values: Omit<HealthState, "date">, tz: string): HealthState => {
  const current = getHealth(tz);
  const next: HealthState = { ...current, ...values, date: todayStr(tz) };
  const s = load();
  s.health = next;
  save(s);
  return next;
};

// ---------- gratitude journal (one editable entry per local day) ----------

// Today's entry (or a specific day's), or undefined if nothing's written yet.
export const getGratitude = (tz: string, day?: string): string | undefined =>
  load().gratitude?.[day ?? todayStr(tz)];

// Overwrite today's gratitude entry. One entry per day — re-saving replaces it.
export const setGratitude = (text: string, tz: string): void => {
  const s = load();
  s.gratitude = { ...(s.gratitude ?? {}), [todayStr(tz)]: text };
  save(s);
};

// The journal-channel message id posted for a day's entry (if the optional
// gratitude channel is configured). Lets edits update that day's card in place
// instead of posting a duplicate.
export const getGratitudeMessageId = (tz: string, day?: string): string | undefined =>
  load().gratitudeMessages?.[day ?? todayStr(tz)];

export const setGratitudeMessageId = (id: string, tz: string): void => {
  const s = load();
  s.gratitudeMessages = { ...(s.gratitudeMessages ?? {}), [todayStr(tz)]: id };
  save(s);
};

// ---------- custom habits ----------

export const getCustomHabits = (): Habit[] => load().customHabits ?? [];

// Append a custom habit. The caller (habits.addHabitFromInput) is responsible for
// validation and dedup; this just persists.
export const addCustomHabit = (habit: Habit): void => {
  const s = load();
  s.customHabits = [...(s.customHabits ?? []), habit];
  save(s);
};

// Remove a custom habit by id. Returns true if one was removed. Its streak state
// (state.habits[id]) is intentionally left in place, so re-adding restores history.
export const removeCustomHabit = (id: string): boolean => {
  const s = load();
  const before = s.customHabits ?? [];
  const after = before.filter((h) => h.id !== id);
  if (after.length === before.length) return false;
  s.customHabits = after;
  save(s);
  return true;
};
