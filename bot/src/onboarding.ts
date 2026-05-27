/**
 * Scripted 3-question onboarding flow.
 *
 * Runs before any Claude call. While the user's profile is incomplete, every
 * inbound message is treated as an answer to the current question — no AI in
 * the loop, fully deterministic. Once `complete`, processMessage falls through
 * to the Claude flow.
 *
 * `stop` always opts out, even mid-onboarding.
 */

import type { DocumentReference } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

export type OnboardingStep =
  | "pending"        // never asked; emit first question, advance
  | "ask_goal"       // goal question sent, awaiting answer
  | "ask_energy"     // energy question sent, awaiting answer
  | "self_do"        // enrichment failed → asked "what do you do", awaiting bio
  | "self_topics"    // asked topics, awaiting comma list
  | "self_meet"      // asked who to meet, awaiting answer
  | "complete";

export interface OnboardingState {
  step?: OnboardingStep;
  startedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
  // Scratch space for the self-profile interview — committed to enrichment.*
  // only on the final answer so nothing half-filled leaks to the directory.
  draftBio?: string;
  draftTopics?: string[];
}

export interface UserDocLike {
  displayName?: string;
  goal?: string;
  energy?: "1on1" | "group" | "both";
  // "linkedin" means they signed in on the website via LinkedIn OIDC.
  // Bots short-circuit onboarding for these — LinkedIn is the approval gate.
  signInProvider?: string;
  // Background enrichment populates these (NOT asked):
  enrichment?: {
    status?: "pending" | "running" | "complete" | "failed";
    publishable?: boolean;
    confidence?: string;
    source?: string;
    bio?: string;
    topics?: string[];
    company?: string;
    recentActivity?: string;
    matchSignals?: string;
  };
  onboarding?: OnboardingState;
}

export interface OnboardingOutcome {
  /** True if onboarding handled the turn (caller should skip Claude). */
  handled: boolean;
  /** Reply to send to the user — empty if nothing to say. */
  reply: string;
}

// Onboarding asks ONLY things web search / LinkedIn can't tell us:
// the user's *intent* for this specific event and their *energy* preference.
// Bio, topics, company etc. are filled by the async enrichment worker.

const ASK_GOAL =
  "Welcome to Viva Tribe! I'll match you with humans at VivaTech.\n\n" +
  "2 quick questions — then you're set.\n\n" +
  "1/2 — what's your goal at VivaTech? One line. Like \"meet European AI VCs\", " +
  "\"sell to enterprise CFOs\", or \"find a co-founder\".";

const ASK_ENERGY =
  "2/2 — how do you like to meet people? Reply with one word:\n" +
  "• `1on1` — quiet 1-on-1 convos\n" +
  "• `group` — mixers, dinners, lounges\n" +
  "• `both`";

const COMPLETE =
  "All set ✓\n\n" +
  "I'm pulling your professional profile from the web in the background — should be ready in a minute.\n\n" +
  "In the meantime, try:\n" +
  "• find me a buddy — someone to explore VivaTech with\n" +
  "• find me <topic> — specific people\n" +
  "• who is here\n" +
  "• free for 30";

const OPTED_OUT = "Opted out. You won't hear from me again. Reply anything to come back.";

function parseEnergy(text: string): "1on1" | "group" | "both" | null {
  const t = text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["1on1", "1to1", "oneonone", "one"].includes(t)) return "1on1";
  if (["group", "mixer", "mixers", "social"].includes(t)) return "group";
  if (["both", "all", "either"].includes(t)) return "both";
  return null;
}

// Self-profile interview — the fallback when web enrichment can't confidently
// identify someone. We collect the same fields enrichment would have produced,
// straight from the person, so the matcher + directory keep working.
const ASK_SELF_DO =
  "I couldn't auto-build your profile from the web, so 3 quick questions to match you well.\n\n" +
  "1/3 — In one line, what do you do?";
const ASK_SELF_TOPICS =
  '2/3 — Your areas/topics? Comma-separated. E.g. "AI, climate, fintech".';
const ASK_SELF_MEET =
  "3/3 — Who do you want to meet at VivaTech? One line.";
const SELF_COMPLETE =
  "All set ✓ Matching you now.\n\n" +
  "Try:\n" +
  "• find me a buddy\n" +
  "• find me <topic>\n" +
  "• who is here";

const SELF_STEPS: OnboardingStep[] = ["self_do", "self_topics", "self_meet"];

function parseTopics(text: string): string[] {
  return text
    .split(/[,\n;/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 6)
    .map((t) => t.slice(0, 40));
}

// True once enrichment has settled (complete/failed) WITHOUT producing a
// usable, publishable profile. enrichUser always writes a boolean `publishable`;
// a self-completed profile sets publishable:true, so this flips back to false
// once the interview is done — no re-asking.
function needsSelfProfile(userDoc: UserDocLike): boolean {
  const e = userDoc.enrichment;
  if (!e) return false;
  const settled = e.status === "complete" || e.status === "failed";
  return settled && e.publishable !== true;
}

async function runSelfInterview(
  userRef: DocumentReference,
  userDoc: UserDocLike,
  trimmed: string,
  step: OnboardingStep
): Promise<OnboardingOutcome> {
  switch (step) {
    case "self_do": {
      const bio = trimmed.slice(0, 200);
      if (!bio) return { handled: true, reply: "One line on what you do. " + ASK_SELF_DO };
      await userRef.set(
        { onboarding: { step: "self_topics", draftBio: bio } },
        { merge: true }
      );
      return { handled: true, reply: ASK_SELF_TOPICS };
    }

    case "self_topics": {
      const topics = parseTopics(trimmed);
      if (topics.length === 0) {
        return { handled: true, reply: "List a few, comma-separated. " + ASK_SELF_TOPICS };
      }
      await userRef.set(
        { onboarding: { step: "self_meet", draftTopics: topics } },
        { merge: true }
      );
      return { handled: true, reply: ASK_SELF_MEET };
    }

    case "self_meet": {
      const matchSignals = trimmed.slice(0, 200);
      if (!matchSignals) {
        return { handled: true, reply: "One line on who you want to meet. " + ASK_SELF_MEET };
      }
      const draftBio = userDoc.onboarding?.draftBio ?? "";
      const draftTopics = userDoc.onboarding?.draftTopics ?? [];
      // Write into the same enrichment fields the matcher + web directory read.
      // source:"self" + publishable:true — self-reported data is authoritative,
      // so it's safe to publish and flips needsSelfProfile() back to false.
      await userRef.set(
        {
          enrichment: {
            status: "complete",
            source: "self",
            confidence: "self",
            publishable: true,
            bio: draftBio,
            topics: draftTopics,
            matchSignals,
            completedAt: FieldValue.serverTimestamp(),
          },
          onboarding: {
            step: "complete",
            completedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
      return { handled: true, reply: SELF_COMPLETE };
    }

    default:
      return { handled: false, reply: "" };
  }
}

export async function runOnboardingStep(
  userRef: DocumentReference,
  userDoc: UserDocLike,
  userMessage: string
): Promise<OnboardingOutcome> {
  const trimmed = userMessage.trim();
  const step: OnboardingStep = userDoc.onboarding?.step ?? "pending";

  // Universal escape hatch — `stop` always works.
  if (/^stop$/i.test(trimmed)) {
    await userRef.set(
      { status: "opted_out", optedOutAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { handled: true, reply: OPTED_OUT };
  }

  // In-chat self-profile interview already running — keep collecting answers.
  if (SELF_STEPS.includes(step)) {
    return runSelfInterview(userRef, userDoc, trimmed, step);
  }

  // Enrichment settled but produced no usable profile → collect it in chat so
  // the person isn't left unmatchable. Applies to everyone (incl. LinkedIn
  // sign-ins) and overrides the short-circuit below. Don't treat the current
  // message as an answer — just emit Q1 and advance.
  if (needsSelfProfile(userDoc)) {
    await userRef.set(
      { onboarding: { step: "self_do", startedAt: FieldValue.serverTimestamp() } },
      { merge: true }
    );
    return { handled: true, reply: ASK_SELF_DO };
  }

  // LinkedIn login is the approval gate — these users skip the 2-question
  // onboarding entirely and go straight to Claude with the command menu
  // they got from /start (or that Claude returns on unclear input).
  // Mark onboarding.step = complete idempotently so future turns also skip.
  if (userDoc.signInProvider === "linkedin") {
    if (step !== "complete") {
      await userRef.set(
        {
          onboarding: {
            step: "complete",
            completedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
    }
    return { handled: false, reply: "" };
  }

  if (step === "complete") {
    return { handled: false, reply: "" };
  }

  switch (step) {
    case "pending": {
      // First contact post-seed (not via /start). Emit Q1, advance state.
      // Don't try to interpret the current message as an answer — they
      // haven't been asked anything yet.
      await userRef.set(
        {
          onboarding: {
            step: "ask_goal",
            startedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
      return { handled: true, reply: ASK_GOAL };
    }

    case "ask_goal": {
      const goal = trimmed.slice(0, 240);
      if (!goal) {
        return {
          handled: true,
          reply: "Need one line on your goal. " + ASK_GOAL,
        };
      }
      // Use nested-object syntax — dot-notation keys in set({...}, {merge}) are
      // treated as LITERAL field names by the Admin SDK, not field paths.
      await userRef.set(
        { goal, onboarding: { step: "ask_energy" } },
        { merge: true }
      );
      return { handled: true, reply: ASK_ENERGY };
    }

    case "ask_energy": {
      const energy = parseEnergy(trimmed);
      if (!energy) {
        return {
          handled: true,
          reply: "Reply `1on1`, `group`, or `both`. " + ASK_ENERGY,
        };
      }
      await userRef.set(
        {
          energy,
          onboarding: {
            step: "complete",
            completedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
      return { handled: true, reply: COMPLETE };
    }

    default: {
      // Unknown step — reset and re-ask.
      await userRef.set(
        { onboarding: { step: "pending" } },
        { merge: true }
      );
      return { handled: true, reply: ASK_GOAL };
    }
  }
}
