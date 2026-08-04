// habits.ts — the list of habits the bot tracks.
//
// Each habit needs:
//   id       — a short, unique, stable key (used in state.json; don't change it later
//              or you'll orphan that habit's saved streak).
//   name     — the pretty label shown in Discord messages.
//   emoji    — shown next to the name in the daily check-in, evening nudge, and summary.
//   keywords — words/phrases that, when they appear in your reply, check this habit off.
//              Matching is case-insensitive and whole-word, so "read" won't match
//              "already", and "pray" won't match "prayer" (that's why verb forms like
//              "prayed"/"prayer" are listed separately). A basic negation guard means
//              "didn't shower" won't count.
//
// A single reply can check off several habits at once, e.g. "drank my water and prayed".

import * as store from "./store";

// The three parts of the day a habit belongs to. Each slot is pinged at its own
// time (see MORNING_TIME / AFTERNOON_TIME / EVENING_TIME in index.ts).
export type TimeSlot = "morning" | "afternoon" | "evening";

export const SLOTS: TimeSlot[] = ["morning", "afternoon", "evening"];

export const isTimeSlot = (s: string): s is TimeSlot =>
  (SLOTS as string[]).includes(s.toLowerCase());

export interface Habit {
  id: string;
  name: string;
  emoji: string;
  slot: TimeSlot; // which daily check-in this habit belongs to
  keywords: string[];
}

// The default icon a custom habit gets when the user doesn't supply an emoji.
export const DEFAULT_HABIT_EMOJI = "📌";

// The built-in habits. These always exist; custom habits (added via /add-habit)
// are stored separately and merged in by allHabits().
export const habits: Habit[] = [
  {
    id: "water",
    name: "Drink 1 gallon of water",
    emoji: "💧",
    slot: "morning",
    keywords: ["water", "gallon", "hydrate", "hydrated"],
  },
  {
    id: "reading",
    name: "Read for 30 minutes",
    emoji: "📖",
    slot: "evening",
    keywords: ["read", "reading", "book", "chapter"],
  },
  {
    id: "pray",
    name: "Pray",
    emoji: "🙏",
    slot: "morning",
    keywords: ["pray", "prayed", "prayer", "prayers", "praying"],
  },
  {
    id: "meditate",
    name: "Meditate",
    emoji: "🧘",
    slot: "morning",
    keywords: ["meditate", "meditated", "meditation", "meditating", "mindfulness"],
  },
  {
    id: "gratitude",
    name: "Gratitude journal",
    emoji: "📓",
    slot: "evening",
    keywords: ["gratitude", "grateful", "thankful", "journal", "journaled", "journaling"],
  },
  {
    id: "breakfast",
    name: "Eat breakfast",
    emoji: "🍳",
    slot: "morning",
    keywords: ["breakfast"],
  },
  {
    id: "lunch",
    name: "Eat lunch",
    emoji: "🥪",
    slot: "afternoon",
    keywords: ["lunch", "lunched"],
  },
  {
    id: "dinner",
    name: "Eat dinner",
    emoji: "🍽️",
    slot: "evening",
    keywords: ["dinner", "supper"],
  },
  {
    id: "teeth",
    name: "Brush teeth and floss",
    emoji: "🪥",
    slot: "morning",
    keywords: ["brush teeth", "brushed teeth", "teeth", "floss", "flossed", "flossing"],
  },
  {
    id: "shower",
    name: "Shower for 10 minutes",
    emoji: "🚿",
    slot: "morning",
    keywords: ["shower", "showered", "showering", "bath", "bathed"],
  },
  {
    id: "clean_room",
    name: "Clean room",
    emoji: "🧹",
    slot: "evening",
    keywords: ["clean room", "cleaned room", "clean my room", "cleaned my room", "tidy", "tidied"],
  },
  {
    id: "walk_dog",
    name: "Walk dog",
    emoji: "🐕",
    slot: "afternoon",
    keywords: ["walk dog", "walked dog", "walk the dog", "walked the dog", "walked my dog", "dog walk"],
  },
  {
    id: "steps",
    name: "Hit 10k steps",
    emoji: "👟",
    slot: "afternoon",
    keywords: ["steps", "10k", "10k steps", "10,000 steps"],
  },
];

// ---------- dynamic registry (built-ins + custom) ----------

// Every place that iterates habits should use this, not the static `habits`
// array, so user-added habits are tracked everywhere (daily prompt, summary,
// keyword matching, undo). Custom habits are appended after the built-ins.
export const allHabits = (): Habit[] => [...habits, ...store.getCustomHabits()];

export const findHabit = (id: string): Habit | undefined =>
  allHabits().find((h) => h.id === id);

// Every habit (built-in + custom) that belongs to a given time slot, in list order.
export const habitsInSlot = (slot: TimeSlot): Habit[] =>
  allHabits().filter((h) => h.slot === slot);

// ---------- adding a custom habit ----------

// Short words we don't want to become check-off keywords on their own.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "my", "for", "in", "on", "at",
  "with", "do", "did", "get", "got", "some", "your", "you",
]);

// Turn a name into a stable id fragment: lowercase, non-alphanumerics → "_".
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

// Derive check-off keywords from a habit name: the whole phrase, plus each
// meaningful word (≥3 chars, not a stopword). Lets you check it off by typing
// the name or any significant word from it.
export const deriveKeywords = (name: string): string[] => {
  const phrase = name.toLowerCase().trim();
  const words = phrase.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set([phrase, ...words])).filter(Boolean);
};

// Pull an optional leading emoji off the input, e.g. "🧴 Moisturize" →
// { emoji: "🧴", name: "Moisturize" }. Handles multi-codepoint emoji (ZWJ
// sequences, skin-tone/variation modifiers). No leading emoji → default icon.
export const parseHabitInput = (arg: string): { emoji?: string; name: string } => {
  const trimmed = arg.trim();
  // A leading emoji: one pictographic base plus any ZWJ joins, variation
  // selectors, skin-tone modifiers, or keycap combiners, then whitespace + name.
  const m =
    /^(\p{Extended_Pictographic}[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}⃣]*)\s+(.+)$/u.exec(
      trimmed,
    );
  if (m && m[2].trim()) return { emoji: m[1], name: m[2].trim() };
  return { name: trimmed };
};

export interface AddHabitResult {
  ok: boolean;
  habit?: Habit;
  error?: string;
}

// Pull a required leading time slot off the input, e.g. "morning 🧴 Moisturize"
// → { slot: "morning", rest: "🧴 Moisturize" }. Returns undefined slot if the
// first word isn't one of morning/afternoon/evening.
export const parseSlotInput = (arg: string): { slot?: TimeSlot; rest: string } => {
  const trimmed = arg.trim();
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (!isTimeSlot(firstToken)) return { rest: trimmed };
  return {
    slot: firstToken.toLowerCase() as TimeSlot,
    rest: trimmed.slice(firstToken.length).trim(),
  };
};

const SLOT_HINT =
  "Pick a time slot — `morning`, `afternoon`, or `evening` — with `/add-habit`.";

// Validate, build, and persist a custom habit from raw "/add-habit" input.
// Pure enough to unit-test (it only touches store, which is DATA_DIR-backed).
export const addHabitFromInput = (arg: string): AddHabitResult => {
  const { slot, rest } = parseSlotInput(arg);
  if (!slot) {
    return { ok: false, error: SLOT_HINT };
  }

  const { emoji, name: rawName } = parseHabitInput(rest);
  const name = rawName.replace(/\s+/g, " ").trim();

  if (!name) {
    return {
      ok: false,
      error: "Give the habit a name — e.g. `/add-habit slot:morning name:Stretch for 5 minutes`.",
    };
  }
  if (name.length > 80) {
    return { ok: false, error: "That name's too long — keep it under 80 characters." };
  }

  const slug = slugify(name);
  if (!slug) {
    return { ok: false, error: "That name has no letters or numbers I can use — try a plain name." };
  }

  const id = `custom_${slug}`;
  const clash = allHabits().find(
    (h) => h.id === id || h.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    return { ok: false, error: `${clash.emoji} **${clash.name}** is already a habit.` };
  }

  const habit: Habit = {
    id,
    name,
    emoji: emoji?.trim() || DEFAULT_HABIT_EMOJI,
    slot,
    keywords: deriveKeywords(name),
  };
  store.addCustomHabit(habit);
  return { ok: true, habit };
};
