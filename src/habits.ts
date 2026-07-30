// habits.ts — the list of habits the bot tracks.
//
// Each habit needs:
//   id       — a short, unique, stable key (used in state.json; don't change it later
//              or you'll orphan that habit's saved streak).
//   name     — the pretty label shown in Discord messages.
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
  keywords: string[];
}

export const habits: Habit[] = [
  {
    id: "water",
    name: "Drink 1 gallon of water",
    keywords: ["water", "gallon", "hydrate", "hydrated"],
  },
  {
    id: "reading",
    name: "Read for 30 minutes",
    keywords: ["read", "reading", "book", "chapter"],
  },
  {
    id: "pray",
    name: "Pray",
    keywords: ["pray", "prayed", "prayer", "prayers", "praying"],
  },
  {
    id: "meditate",
    name: "Meditate",
    keywords: ["meditate", "meditated", "meditation", "meditating", "mindfulness"],
  },
  {
    id: "gratitude",
    name: "Gratitude journal",
    keywords: ["gratitude", "grateful", "thankful", "journal", "journaled", "journaling"],
  },
  {
    id: "breakfast",
    name: "Eat breakfast",
    keywords: ["breakfast"],
  },
  {
    id: "lunch",
    name: "Eat lunch",
    keywords: ["lunch", "lunched"],
  },
  {
    id: "dinner",
    name: "Eat dinner",
    keywords: ["dinner", "supper"],
  },
  {
    id: "teeth",
    name: "Brush teeth and floss",
    keywords: ["brush teeth", "brushed teeth", "teeth", "floss", "flossed", "flossing"],
  },
  {
    id: "shower",
    name: "Shower for 10 minutes",
    keywords: ["shower", "showered", "showering", "bath", "bathed"],
  },
  {
    id: "clean_room",
    name: "Clean room",
    keywords: ["clean room", "cleaned room", "clean my room", "cleaned my room", "tidy", "tidied"],
  },
  {
    id: "walk_dog",
    name: "Walk dog",
    keywords: ["walk dog", "walked dog", "walk the dog", "walked the dog", "walked my dog", "dog walk"],
  },
  {
    id: "steps",
    name: "Hit 10k steps",
    keywords: ["steps", "10k", "10k steps", "10,000 steps"],
  },
];

export default habits;
