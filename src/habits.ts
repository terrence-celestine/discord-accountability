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

export interface Habit {
  id: string;
  name: string;
  emoji: string;
  keywords: string[];
}

export const habits: Habit[] = [
  {
    id: "water",
    name: "Drink 1 gallon of water",
    emoji: "💧",
    keywords: ["water", "gallon", "hydrate", "hydrated"],
  },
  {
    id: "reading",
    name: "Read for 30 minutes",
    emoji: "📖",
    keywords: ["read", "reading", "book", "chapter"],
  },
  {
    id: "pray",
    name: "Pray",
    emoji: "🙏",
    keywords: ["pray", "prayed", "prayer", "prayers", "praying"],
  },
  {
    id: "meditate",
    name: "Meditate",
    emoji: "🧘",
    keywords: ["meditate", "meditated", "meditation", "meditating", "mindfulness"],
  },
  {
    id: "gratitude",
    name: "Gratitude journal",
    emoji: "📓",
    keywords: ["gratitude", "grateful", "thankful", "journal", "journaled", "journaling"],
  },
  {
    id: "breakfast",
    name: "Eat breakfast",
    emoji: "🍳",
    keywords: ["breakfast"],
  },
  {
    id: "lunch",
    name: "Eat lunch",
    emoji: "🥪",
    keywords: ["lunch", "lunched"],
  },
  {
    id: "dinner",
    name: "Eat dinner",
    emoji: "🍽️",
    keywords: ["dinner", "supper"],
  },
  {
    id: "teeth",
    name: "Brush teeth and floss",
    emoji: "🪥",
    keywords: ["brush teeth", "brushed teeth", "teeth", "floss", "flossed", "flossing"],
  },
  {
    id: "shower",
    name: "Shower for 10 minutes",
    emoji: "🚿",
    keywords: ["shower", "showered", "showering", "bath", "bathed"],
  },
  {
    id: "clean_room",
    name: "Clean room",
    emoji: "🧹",
    keywords: ["clean room", "cleaned room", "clean my room", "cleaned my room", "tidy", "tidied"],
  },
  {
    id: "walk_dog",
    name: "Walk dog",
    emoji: "🐕",
    keywords: ["walk dog", "walked dog", "walk the dog", "walked the dog", "walked my dog", "dog walk"],
  },
  {
    id: "steps",
    name: "Hit 10k steps",
    emoji: "👟",
    keywords: ["steps", "10k", "10k steps", "10,000 steps"],
  },
];
