// Pure Verse-of-the-Day logic (no network — the fetch orchestrator isn't exercised here).
import { test, expect } from "vitest";
import { dayOfYear, toVerse } from "../src/votd";
import { buildVerseOfDay } from "../src/logic";

const cardText = (msg: { embeds: { data: { title?: string; description?: string; footer?: { text?: string } } }[] }): string => {
  const e = msg.embeds[0].data;
  return `${e.title ?? ""}\n${e.description ?? ""}\n${e.footer?.text ?? ""}`;
};

test("dayOfYear: Jan 1 is day 1", () => {
  expect(dayOfYear("2026-01-01")).toBe(1);
});

test("dayOfYear: Dec 31 of a non-leap year is day 365", () => {
  expect(dayOfYear("2026-12-31")).toBe(365);
});

test("dayOfYear: Feb 29 of a leap year is day 60", () => {
  expect(dayOfYear("2024-02-29")).toBe(60);
});

test("dayOfYear: Dec 31 of a leap year is day 366", () => {
  expect(dayOfYear("2024-12-31")).toBe(366);
});

test("toVerse maps fields and trims whitespace", () => {
  const v = toVerse({ id: "JHN.3.16", content: "  For God so loved the world  ", reference: " John 3:16 " });
  expect(v).toEqual({
    passageId: "JHN.3.16",
    reference: "John 3:16",
    text: "For God so loved the world",
  });
});

test("toVerse strips stray HTML and collapses whitespace", () => {
  const v = toVerse({
    id: "ISA.12.2",
    content: "<p>Behold, God <b>is</b>\n  my salvation</p>",
    reference: "Isaiah 12:2",
  });
  expect(v.text).toBe("Behold, God is my salvation");
});

test("buildVerseOfDay renders the verse, reference, version, and attribution", () => {
  const text = cardText(
    buildVerseOfDay({ reference: "John 3:16", text: "For God so loved the world" }, "KJV"),
  );
  expect(text).toMatch(/Verse of the Day/i);
  expect(text).toContain("For God so loved the world");
  expect(text).toContain("John 3:16");
  expect(text).toContain("KJV");
  expect(text).toContain("via YouVersion");
});
