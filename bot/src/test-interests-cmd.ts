/**
 * Regression test for post-onboarding interest-command routing.
 *
 * "Add one more thing cricket" after sign-up used to fall through to Claude,
 * which guessed an event. Members now have `add interest <x>` / `remove
 * interest <x>` / `my interests`. isInterestCommand must recognize those (EN +
 * FR) so the onboarding gate doesn't swallow them and they route to the
 * deterministic handler — while NOT matching event commands or plain chatter.
 *
 * Run: npx tsx src/test-interests-cmd.ts
 */
import { isInterestCommand } from "./brain.js";

let failures = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label} → ${actual} (expected ${expected})`);
}

// Should be recognized as interest commands
for (const s of [
  "add interest cricket",
  "add interests cricket, chess",
  "add to my interests cricket",
  "add topic fintech",
  "remove interest fintech",
  "delete interest AI",
  "drop my interest crypto",
  "my interests",
  "interests",
  "list my interests",
  "ajouter intérêt cricket",
  "retirer intérêt fintech",
  "mes intérêts",
  "mes centres d'intérêt",
]) {
  check(`interest: ${JSON.stringify(s)}`, isInterestCommand(s), true);
}

// Should NOT be mistaken for interest commands
for (const s of [
  "add event drinks tonight 8pm",
  "create event cricket match tomorrow 2pm",
  "drinks at 8",
  "find me a climate VC",
  "what's on",
  "my events",
  "hello there",
  "join Late lunch",
]) {
  check(`not interest: ${JSON.stringify(s)}`, isInterestCommand(s), false);
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll interest-command routing assertions passed.");
