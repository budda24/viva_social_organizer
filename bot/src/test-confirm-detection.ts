/**
 * Focused regression test for the "Yes/No buttons reappear" bug.
 *
 * A user who TYPES the "✅ Yes, create it" button label ("Create it") instead of
 * tapping it must still be read as a confirmation. Before the fix, YES_LEAD only
 * had the French "crée/cree", so the English echo fell through: the pending
 * action expired and Claude re-proposed the event, re-showing the Yes/No buttons.
 *
 * Asserts:
 *   1. button-label echoes + common confirmations read as affirmative;
 *   2. "create event" / "create a new event" do NOT (they must reach the
 *      event-creation wizard, not confirm a stale pending action);
 *   3. clear negatives stay negative.
 *
 * Run: npx tsx src/test-confirm-detection.ts
 */
import { isAffirmative, isNegative } from "./i18n.js";

let failures = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label} → ${actual} (expected ${expected})`);
}

// Affirmatives — bare token, button-label echoes, and FR equivalents.
for (const t of ["yes", "Yes", "create it", "Create it", "create", "create now", "ok do it", "go ahead", "oui", "crée-le", "cree"]) {
  check(`isAffirmative(${JSON.stringify(t)})`, isAffirmative(t), true);
}

// NOT affirmatives — these must reach the create-event wizard, not confirm.
for (const t of ["create event", "create a new event", "create an event", "créer un événement", "create another event"]) {
  check(`isAffirmative(${JSON.stringify(t)})`, isAffirmative(t), false);
}

// Negatives — leading no-word declines.
for (const t of ["no", "No", "nope", "cancel", "nvm", "non", "no thanks"]) {
  check(`isNegative(${JSON.stringify(t)})`, isNegative(t), true);
  check(`isAffirmative(${JSON.stringify(t)})`, isAffirmative(t), false);
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll confirmation-detection assertions passed.");
