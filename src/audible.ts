// audible.ts — optional integration that auto-checks off the Reading habit based on
// real Audible listening time. If no credentials are configured, it's completely inert.
//
// audible-api-ts is ESM-only, so at runtime we load it via a genuine dynamic import()
// (a normal `import` would be transpiled to require() by tsc and fail on an ESM package).
// Types come from `import type`, which compiles away to nothing.

import fs from "fs";
import path from "path";
import type { AudibleCredentials, AudibleItem } from "audible-api-ts";
import * as store from "./store";

type AudibleApi = typeof import("audible-api-ts");
const importAudibleApi = new Function('return import("audible-api-ts")') as () => Promise<AudibleApi>;

const READING_HABIT_ID = "reading";

const dataDir = (): string => process.env.DATA_DIR || "/data";
const credentialsPath = (): string =>
  process.env.AUDIBLE_CREDENTIALS_FILE || path.join(dataDir(), "audible-credentials.json");

// ---------- credential persistence ----------

// JSON.parse turns Date fields into strings; revive expiresAt so refresh logic works.
const reviveCredentials = (raw: AudibleCredentials): AudibleCredentials => ({
  ...raw,
  expiresAt: new Date(raw.expiresAt),
});

export const saveCredentials = (creds: AudibleCredentials): void => {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2));
};

// Load creds from the volume file; bootstrap from the AUDIBLE_CREDENTIALS env var on first
// run (then persist to the volume so future token refreshes stick). null → integration off.
export const loadCredentials = (): AudibleCredentials | null => {
  const file = credentialsPath();
  if (fs.existsSync(file)) {
    return reviveCredentials(JSON.parse(fs.readFileSync(file, "utf8")));
  }
  const env = process.env.AUDIBLE_CREDENTIALS;
  if (env) {
    const creds = reviveCredentials(JSON.parse(env));
    saveCredentials(creds);
    return creds;
  }
  return null;
};

export const isConfigured = (): boolean => loadCredentials() !== null;

// ---------- pure derivation (unit-tested) ----------

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// Total lifetime minutes listened = Σ (book length × how far through it you are).
// Monotonically increases as you listen, which is what lets us diff it per day.
export const totalListenedMinutes = (
  items: Pick<AudibleItem, "durationMinutes" | "listeningStatus">[],
): number =>
  items.reduce((sum, it) => {
    const pct = it.listeningStatus?.percentComplete ?? 0;
    return sum + (it.durationMinutes * clamp(pct, 0, 100)) / 100;
  }, 0);

// Given the previous baseline and the current total, work out minutes listened *today*.
export const computeMinutesToday = (
  prev: store.AudibleState,
  currentTotal: number,
  today: string,
): { minutesToday: number; next: store.AudibleState } => {
  let baselineTotal = prev.baselineTotal;
  if (prev.baselineDate !== today) {
    // New day → anchor the baseline to yesterday's last observed total, so listening done
    // before today's first poll still counts. On the very first run, anchor to now (0 today).
    baselineTotal = prev.baselineDate === null ? currentTotal : prev.lastTotal;
  }
  const minutesToday = Math.max(0, currentTotal - baselineTotal);
  return { minutesToday, next: { baselineDate: today, baselineTotal, lastTotal: currentTotal } };
};

// ---------- orchestration (network) ----------

export interface AudiblePollResult {
  minutesToday: number;
  checkedOff: boolean; // true only on the transition to done today (so we announce once)
  currentStreak: number;
}

// Fetch listening progress, update the daily baseline, and check off Reading if past the
// threshold. Throws on network/auth errors (the caller logs and swallows).
export const pollAudible = async (
  tz: string,
  thresholdMinutes: number,
): Promise<AudiblePollResult> => {
  const creds = loadCredentials();
  if (!creds) return { minutesToday: 0, checkedOff: false, currentStreak: 0 };

  const api = await importAudibleApi();
  const { items, credentials } = await api.library(creds);
  saveCredentials(credentials); // persist any token refresh the call performed

  const currentTotal = totalListenedMinutes(items);
  const today = store.todayStr(tz);
  const { minutesToday, next } = computeMinutesToday(store.getAudibleState(), currentTotal, today);
  store.setAudibleState(next);

  if (minutesToday < thresholdMinutes) {
    return { minutesToday, checkedOff: false, currentStreak: 0 };
  }
  const res = store.checkOff(READING_HABIT_ID, tz);
  return { minutesToday, checkedOff: !res.alreadyDone, currentStreak: res.currentStreak };
};
