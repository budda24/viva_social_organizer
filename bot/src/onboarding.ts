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
  | "complete";

export interface OnboardingState {
  step?: OnboardingStep;
  startedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
}

export interface UserDocLike {
  displayName?: string;
  goal?: string;
  energy?: "1on1" | "group" | "both";
  // Background enrichment populates these (NOT asked):
  enrichment?: {
    status?: "pending" | "running" | "complete" | "failed";
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
