// Custom habits added at runtime via /add_habit.
import { test, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";
import {
  addHabitFromInput,
  allHabits,
  parseHabitInput,
  slugify,
  deriveKeywords,
  habits,
  DEFAULT_HABIT_EMOJI,
} from "../src/habits";
import { matchedHabits, buildSummary } from "../src/logic";

const TZ = "America/Los_Angeles";

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-custom-"));
});

// Reset both streak state and custom habits before each test.
beforeEach(() => store.save({ habits: {} }));

test("slugify produces a safe id fragment", () => {
  expect(slugify("Stretch for 5 minutes")).toBe("stretch_for_5_minutes");
  expect(slugify("  Yoga!!  ")).toBe("yoga");
  expect(slugify("🧴")).toBe(""); // no alphanumerics
});

test("deriveKeywords keeps the phrase and meaningful words, drops stopwords", () => {
  const kw = deriveKeywords("Stretch for 5 minutes");
  expect(kw).toContain("stretch for 5 minutes"); // whole phrase
  expect(kw).toContain("stretch");
  expect(kw).toContain("minutes");
  expect(kw).not.toContain("for"); // stopword
});

test("parseHabitInput pulls a leading emoji off the name", () => {
  expect(parseHabitInput("🧴 Moisturize")).toEqual({ emoji: "🧴", name: "Moisturize" });
  expect(parseHabitInput("Moisturize")).toEqual({ name: "Moisturize" });
});

test("addHabitFromInput adds a habit with the default icon and tracks it", () => {
  const res = addHabitFromInput("Stretch for 5 minutes");
  expect(res.ok).toBe(true);
  expect(res.habit!.emoji).toBe(DEFAULT_HABIT_EMOJI);
  expect(res.habit!.id).toBe("custom_stretch_for_5_minutes");

  // It now appears in the merged registry, after the built-ins.
  const all = allHabits();
  expect(all.length).toBe(habits.length + 1);
  expect(all.some((h) => h.id === "custom_stretch_for_5_minutes")).toBe(true);
});

test("addHabitFromInput honors a supplied emoji", () => {
  const res = addHabitFromInput("🧴 Moisturize");
  expect(res.ok).toBe(true);
  expect(res.habit!.emoji).toBe("🧴");
  expect(res.habit!.name).toBe("Moisturize");
});

test("a custom habit is matchable by name and by a keyword, then checks off", () => {
  addHabitFromInput("Play guitar");
  expect(matchedHabits("I finally played some guitar today").map((h) => h.id)).toContain(
    "custom_play_guitar",
  );

  const r = store.checkOff("custom_play_guitar", TZ);
  expect(r.currentStreak).toBe(1);
});

test("a custom habit shows up in the summary", () => {
  addHabitFromInput("Play guitar");
  const s = buildSummary(TZ);
  const text = JSON.stringify(s.embeds[0].data);
  expect(text).toContain("Play guitar");
});

test("duplicate names are rejected", () => {
  expect(addHabitFromInput("Yoga").ok).toBe(true);
  const dup = addHabitFromInput("yoga"); // case-insensitive clash
  expect(dup.ok).toBe(false);
  expect(dup.error).toMatch(/already a habit/);
});

test("empty and symbol-only names are rejected", () => {
  expect(addHabitFromInput("   ").ok).toBe(false);
  expect(addHabitFromInput("🧴").ok).toBe(false); // no name after the emoji
  expect(addHabitFromInput("!!!").ok).toBe(false);
});

test("custom habits survive a reload (persisted to disk)", () => {
  addHabitFromInput("Journal at night");
  expect(store.getCustomHabits().map((h) => h.id)).toEqual(["custom_journal_at_night"]);
});

test("removeCustomHabit drops it from the registry", () => {
  addHabitFromInput("Cold shower");
  expect(store.removeCustomHabit("custom_cold_shower")).toBe(true);
  expect(allHabits().some((h) => h.id === "custom_cold_shower")).toBe(false);
  expect(store.removeCustomHabit("custom_nope")).toBe(false);
});
