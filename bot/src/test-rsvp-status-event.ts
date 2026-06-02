/**
 * Focused regression test for the "asked about ONE event, got ALL my RSVPs" bug.
 *
 * A user who asks "Have I signed in in Drink Night?" must be answered about that
 * single event — not handed the full list of every event they're signed in for.
 * Before the fix, the RSVP-status branch ignored any named event and always
 * dumped the whole list. extractRsvpEventName pulls the named event (or "" for
 * the genuine list-all phrasings) so buildMyRsvpsReply can narrow to it.
 *
 * Asserts:
 *   1. status questions that NAME an event return that event's title fragment;
 *   2. bare / list-all phrasings ("have I signed in?", "which events am I in?",
 *      "my rsvps") return "" so the reply still lists everything;
 *   3. leading articles/prepositions ("for the rooftop") are stripped.
 *
 * Run: npx tsx src/test-rsvp-status-event.ts
 */
import { extractRsvpEventName } from "./brain.js";

let failures = 0;
function check(label: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label} → ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
}

// Named-event questions — the name (sans articles/punctuation) must come back.
const named: Array<[string, string]> = [
  ["Have I signed in in Drink Night?", "Drink Night"],
  ["Am I in Drink Night", "Drink Night"],
  ["am I going to Drink Night?", "Drink Night"],
  ["did I join Breakfast meet?", "Breakfast meet"],
  ["have I signed in for breakfast meet?", "breakfast meet"],
  ["am I signed in for the rooftop?", "rooftop"],
  ["suis-je inscrit à Drink Night ?", "Drink Night"],
];
for (const [q, want] of named) {
  check(`extractRsvpEventName(${JSON.stringify(q)})`, extractRsvpEventName(q), want);
}

// List-all phrasings — no event named, so the reply must list everything.
for (const q of ["Have I signed in?", "which events am I in?", "my rsvps", "am I going?"]) {
  check(`extractRsvpEventName(${JSON.stringify(q)})`, extractRsvpEventName(q), "");
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll RSVP-status named-event assertions passed.");
