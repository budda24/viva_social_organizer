/**
 * Regression test for tolerant event-title matching (typed join / RSVP-status).
 *
 * Shah typed "join Late launch . Le Marais" for the event "Late lunch · Le
 * Marais" and got "Couldn't find that event" — the old exact-substring match
 * choked on the "launch"→"lunch" typo and the "·"/"." separator. titleMatchesQuery
 * folds punctuation and tolerates a 1-char token typo, but stays strict enough
 * that an unrelated query still misses.
 *
 * Run: npx tsx src/test-title-match.ts
 */
import { titleMatchesQuery } from "./brain.js";

let failures = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label} → ${actual} (expected ${expected})`);
}

// Should MATCH
check('"Late launch . Le Marais" ~ "Late lunch · Le Marais"', titleMatchesQuery("Late lunch · Le Marais", "Late launch . Le Marais"), true);
check('"Late lauch" ~ "Late lunch · Le Marais"', titleMatchesQuery("Late lunch · Le Marais", "Late lauch"), true);
check('exact "Drink Night"', titleMatchesQuery("Drink Night", "Drink Night"), true);
check('substring "lightning demos" ~ "Lightning demos"', titleMatchesQuery("Lightning demos", "lightning demos"), true);
check('"morning run seine" ~ "Morning run · Seine"', titleMatchesQuery("Morning run · Seine", "morning run seine"), true);

// Should MISS — different events must not collide
check('"Drink Night" ✗ "Breakfast meet"', titleMatchesQuery("Breakfast meet", "Drink Night"), false);
check('"Wine + agents" ✗ "Founders coffee"', titleMatchesQuery("Founders coffee", "Wine + agents"), false);
check('empty query', titleMatchesQuery("Drink Night", ""), false);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll title-match assertions passed.");
