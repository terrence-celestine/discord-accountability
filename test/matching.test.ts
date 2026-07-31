// Keyword matching + negation guard. matchedHabits is pure (no disk, no Discord).
import { test, expect } from "vitest";
import { matchedHabits } from "../src/logic";

const ids = (s: string): string[] => matchedHabits(s).map((h) => h.id).sort();

test("a plain mention checks off the right habit", () => {
  expect(ids("meditated this morning")).toEqual(["meditate"]);
});

test("one reply can check off several habits", () => {
  expect(ids("drank my gallon of water, prayed, and ate breakfast")).toEqual([
    "breakfast",
    "pray",
    "water",
  ]);
});

test("an unrelated message matches nothing", () => {
  expect(ids("just chatting about my day")).toEqual([]);
});

test("matching is whole-word: 'already' does not match 'read'", () => {
  expect(ids("already handled that")).toEqual([]);
});

test("matching is case-insensitive and supports multi-word keywords", () => {
  expect(ids("WALKED THE DOG this morning")).toEqual(["walk_dog"]);
});

test("negation guard: \"didn't shower\" does not count", () => {
  expect(ids("didn't shower today")).toEqual([]);
});

test("negation guard: 'no reading' does not count", () => {
  expect(ids("no reading today")).toEqual([]);
});

test("mixed: negated habit skipped, real habit still counts", () => {
  expect(ids("skipped my shower but did some reading")).toEqual(["reading"]);
});

test("no false positive: 'clean' needs 'room'", () => {
  expect(ids("I cleaned the kitchen")).toEqual([]);
});

test("no false positive: 'grateful for my dog' is gratitude, not walk_dog", () => {
  expect(ids("feeling grateful for my dog")).toEqual(["gratitude"]);
});
