// votd.ts — optional "Verse of the Day" integration (YouVersion Platform API).
//
// Inert unless YOUVERSION_APP_KEY is set. Getting a verse is a two-call flow:
//   1) GET /v1/verse_of_the_days/{dayOfYear}      → { day, passage_id }   (a reference, not text)
//   2) GET /v1/bibles/{versionId}/passages/{ref}  → { id, content, reference }  (the actual verse)
// Auth is the header `X-YVP-App-Key` (identifies the app, not `Authorization: Bearer`).
//
// Following audible.ts: the pure bits (day-of-year, response→verse mapping) are unit-tested,
// and the network orchestrator throws on error so the caller can log + skip the day.

import * as store from "./store";

const BASE = "https://api.youversion.com";

export const isConfigured = (): boolean => !!process.env.YOUVERSION_APP_KEY;

// ---------- API response shapes ----------

export interface VotdResponse {
  day: number;
  passage_id: string; // e.g. "ISA.12.2"
}

export interface PassageResponse {
  id: string;
  content: string; // verse text (plain when requested with ?format=text)
  reference: string; // localized human reference, e.g. "Isaiah 12:2"
}

export interface Verse {
  reference: string;
  text: string;
  passageId: string;
}

// ---------- pure helpers (unit-tested) ----------

// Day-of-year (1–366) from a YYYY-MM-DD string. Timezone-free: callers pass the
// already-localized day (via store.todayStr(tz)).
export const dayOfYear = (dateStr: string): number => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = Date.UTC(y, 0, 0);
  const current = Date.UTC(y, m - 1, d);
  return Math.round((current - start) / 86400000);
};

// Map the passage response into our Verse. Defensively strip any stray HTML tags and
// collapse whitespace, so the card looks clean even if `format=text` isn't honored.
export const toVerse = (passage: PassageResponse): Verse => ({
  reference: passage.reference.trim(),
  text: passage.content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
  passageId: passage.id,
});

// ---------- network orchestrator (throws; caller logs/swallows) ----------

const getJson = async <T>(url: string, appKey: string): Promise<T> => {
  const res = await fetch(url, {
    headers: { "X-YVP-App-Key": appKey, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`YouVersion API ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
};

// Fetch today's verse: resolve the day's passage reference, then its text.
export const fetchVerseOfTheDay = async (
  tz: string,
  versionId: string,
  appKey: string,
): Promise<Verse> => {
  const day = dayOfYear(store.todayStr(tz));

  const votd = await getJson<VotdResponse>(`${BASE}/v1/verse_of_the_days/${day}`, appKey);
  const ref = encodeURIComponent(votd.passage_id);
  const passage = await getJson<PassageResponse>(
    `${BASE}/v1/bibles/${versionId}/passages/${ref}?format=text`,
    appKey,
  );
  return toVerse(passage);
};
