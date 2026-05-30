/**
 * Offline eval — does the LOCAL model correctly route an onboarding afterthought?
 *
 * The self-interview is a deterministic state machine; a thin heuristic-gated
 * classifier (onboarding.ts) catches the case where a user tacks an addition or
 * correction onto an EARLIER answer instead of answering the current question
 * (e.g. "Fintech as well" at the who-to-meet step really belongs in topics).
 *
 * This checks both halves of that gate:
 *   - AMENDMENT_GATE_RE fires (or doesn't) as expected (pure, no model)
 *   - classifyAmendment returns the right `target` (local model)
 *
 * Forces LLM_BACKEND=local so a wrong verdict is the LOCAL model's, not Haiku's.
 * Needs no Firestore.
 *
 *   npx tsx src/eval-amendment.ts
 *   LOCAL_CHAT_MODEL=qwen2.5:32b-instruct-q4_K_M npx tsx src/eval-amendment.ts
 */

import "./env.js";

// Force local-only BEFORE importing llm.ts (it reads LLM_BACKEND at module load).
process.env.LLM_BACKEND = "local";

import {
  AMENDMENT_GATE_RE,
  classifyAmendment,
  type OnboardingStep,
} from "./onboarding.js";

interface Case {
  name: string;
  step: OnboardingStep;
  message: string;
  draftBio: string;
  draftTopics: string[];
  // Expected gate hit, and the target the classifier should return.
  expectGate: boolean;
  expectTarget: "current" | "bio" | "topics" | "meet";
  // Optional substring the extracted value should contain (case-insensitive).
  valueIncludes?: string;
}

const BIO = "Software tester";
const TOPICS = ["Manual testing", "automation testing", "AI testing", "LLM testing"];

const CASES: Case[] = [
  // The reported bug: afterthought topic arriving at the who-to-meet step.
  {
    name: '"Fintech as well" at self_meet → topics',
    step: "self_meet",
    message: "Fintech as well",
    draftBio: BIO,
    draftTopics: TOPICS,
    expectGate: true,
    expectTarget: "topics",
    valueIncludes: "fintech",
  },
  {
    name: '"oh and crypto too" at self_meet → topics',
    step: "self_meet",
    message: "oh and crypto too",
    draftBio: BIO,
    draftTopics: TOPICS,
    expectGate: true,
    expectTarget: "topics",
    valueIncludes: "crypto",
  },
  // Genuine who-to-meet answer that happens to contain "and" mid-sentence —
  // gate must NOT fire, so it stays a deterministic current-question answer.
  {
    name: '"AI founders and climate VCs" at self_meet → gate off (current)',
    step: "self_meet",
    message: "AI founders and climate VCs",
    draftBio: BIO,
    draftTopics: TOPICS,
    expectGate: false,
    expectTarget: "current",
  },
  // Gate fires on "also", but it IS a who-to-meet answer → classifier says current.
  {
    name: '"investors, also some operators" at self_meet → current',
    step: "self_meet",
    message: "investors, also some operators",
    draftBio: BIO,
    draftTopics: TOPICS,
    expectGate: true,
    expectTarget: "current",
  },
  // Afterthought-shaped reply at the topics step itself. The classifier may say
  // "topics" (the value does belong there) — production collapses that back to
  // the deterministic topics write since topics IS the current question. The
  // guard that matters: it must NOT be misrouted to "bio".
  {
    name: '"and also fintech" at self_topics → topics (not bio)',
    step: "self_topics",
    message: "and also fintech",
    draftBio: BIO,
    draftTopics: [],
    expectGate: true,
    expectTarget: "topics",
    valueIncludes: "fintech",
  },
];

async function main(): Promise<void> {
  console.log(
    `[eval] model=${process.env.LOCAL_CHAT_MODEL ?? "(default)"} backend=local\n`
  );

  let passed = 0;
  for (const c of CASES) {
    const started = Date.now();
    const notes: string[] = [];
    let ok = true;

    const gate = AMENDMENT_GATE_RE.test(c.message);
    if (gate !== c.expectGate) {
      ok = false;
      notes.push(`gate ${gate} != expected ${c.expectGate}`);
    }

    // The gate decides whether the classifier runs at all; mirror production.
    let target: string = "current";
    let value = c.message;
    if (gate) {
      const verdict = await classifyAmendment(c.step, c.message, c.draftBio, c.draftTopics);
      target = verdict.target;
      value = verdict.value;
    }

    if (target !== c.expectTarget) {
      ok = false;
      notes.push(`target "${target}" != expected "${c.expectTarget}"`);
    }
    if (c.valueIncludes && !value.toLowerCase().includes(c.valueIncludes.toLowerCase())) {
      ok = false;
      notes.push(`value "${value}" missing "${c.valueIncludes}"`);
    }

    const ms = Date.now() - started;
    if (ok) passed++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name}  (${ms}ms)`);
    if (notes.length) console.log(`        ${notes.join(" | ")}`);
  }

  console.log(`\n[eval] ${passed}/${CASES.length} passed`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
