// store.ts — persistent streak state + streak math.
//
// State lives in a single JSON file on disk (a mounted Railway Volume in prod,
// a local folder in dev). Writes are atomic (temp file + rename) so a crash
// mid-write can't corrupt the file.

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_PATH = path.join(DATA_DIR, "state.json");

export interface HabitState {
  currentStreak: number;
  longestStreak: number;
  lastCompletedDate: string | null;
}

export interface State {
  habits: Record<string, HabitState>;
}

export interface CheckOffResult {
  alreadyDone: boolean;
  currentStreak: number;
  longestStreak: number;
}

// ---------- date helpers (all "dates" are local calendar days in a timezone) ----------

// Format a Date as YYYY-MM-DD in the given IANA timezone. 'en-CA' yields ISO-ish output.
function localDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function todayStr(tz: string): string {
  return localDateStr(new Date(), tz);
}

// Pure calendar arithmetic on a YYYY-MM-DD string (timezone-independent).
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return localDateStr(dt, "UTC");
}

function daysBetween(fromStr: string, toStr: string): number {
  const [ay, am, ad] = fromStr.split("-").map(Number);
  const [by, bm, bd] = toStr.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

// ---------- persistence ----------

export function load(): State {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!parsed.habits) parsed.habits = {};
    return parsed as State;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { habits: {} };
    throw err;
  }
}

export function save(state: State): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH); // atomic on the same filesystem
}

function habitState(state: State, habitId: string): HabitState {
  if (!state.habits[habitId]) {
    state.habits[habitId] = {
      currentStreak: 0,
      longestStreak: 0,
      lastCompletedDate: null,
    };
  }
  return state.habits[habitId];
}

// ---------- streak logic ----------

// The streak actually "counts today" only if it was completed today or yesterday.
// If the last completion is older than yesterday, the stored streak is stale/broken.
export function effectiveStreak(hs: HabitState | undefined, tz: string): number {
  if (!hs || !hs.lastCompletedDate) return 0;
  const gap = daysBetween(hs.lastCompletedDate, todayStr(tz));
  if (gap <= 1) return hs.currentStreak; // completed today or yesterday
  return 0; // a full day was missed → broken
}

// Check a habit off for today. Returns a summary of what happened.
export function checkOff(habitId: string, tz: string): CheckOffResult {
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
}

export { STATE_PATH };
