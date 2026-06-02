/**
 * Regression test for the "can't cancel an event that's already underway" rule.
 *
 * Shah asked us to restrict cancelling ONGOING events. isEventOngoing is the
 * single predicate both guard sites use (the cancel request in brain.ts and the
 * execution-time re-check in actions.ts). It must be true only while an event is
 * actually happening — from its start until ONGOING_WINDOW_MS later.
 *
 * Asserts:
 *   1. future events are NOT ongoing (still cancellable);
 *   2. an event whose start just passed IS ongoing (blocked);
 *   3. an event still inside the window IS ongoing;
 *   4. an event past the window (already ended) is NOT ongoing (cancellable);
 *   5. a missing/zero start time is NOT ongoing (don't block on bad data).
 *
 * Run: npx tsx src/test-cancel-ongoing.ts
 */
import { isEventOngoing, ONGOING_WINDOW_MS } from "./actions.js";

let failures = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label} → ${actual} (expected ${expected})`);
}

const now = 1_780_000_000_000; // fixed "now" so the test is deterministic
const MIN = 60_000;

check("future event (starts in 1h)", isEventOngoing(now + 60 * MIN, now), false);
check("just started (1 min ago)", isEventOngoing(now - 1 * MIN, now), true);
check("mid-window (1h in)", isEventOngoing(now - 60 * MIN, now), true);
check("just before window end", isEventOngoing(now - (ONGOING_WINDOW_MS - MIN), now), true);
check("just after window end (ended)", isEventOngoing(now - (ONGOING_WINDOW_MS + MIN), now), false);
check("starts exactly now", isEventOngoing(now, now), true);
check("missing start time (0)", isEventOngoing(0, now), false);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll cancel-ongoing assertions passed.");
