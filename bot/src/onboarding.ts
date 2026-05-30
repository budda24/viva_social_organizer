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
import type { Lang } from "./i18n.js";
import { runStructured } from "./llm.js";

export type OnboardingStep =
  | "pending"        // never asked; emit first question, advance
  | "ask_goal"       // goal question sent, awaiting answer
  | "ask_energy"     // energy question sent, awaiting answer
  | "self_do"        // enrichment failed → asked "what do you do", awaiting bio
  | "self_topics"    // asked topics, awaiting comma list
  | "self_meet"      // asked who to meet, awaiting answer
  | "self_linkedin"  // asked for LinkedIn URL (skippable), awaiting answer
  | "complete";

export interface OnboardingState {
  step?: OnboardingStep;
  startedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
  // Scratch space for the self-profile interview — committed to enrichment.*
  // only on the final answer so nothing half-filled leaks to the directory.
  draftBio?: string;
  draftTopics?: string[];
  draftMatchSignals?: string;
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

// Bilingual onboarding strings (English + French — VivaTech is in Paris).
interface OnboardingStrings {
  askGoal: string;
  needGoal: string;
  askEnergy: string;
  needEnergy: string;
  complete: string;
  optedOut: string;
  askSelfDo: string;
  needSelfDo: string;
  askSelfTopics: string;
  needSelfTopics: string;
  askSelfMeet: string;
  needSelfMeet: string;
  askSelfLinkedin: string;
  needSelfLinkedin: string;
  selfComplete: string;
  // Acks for an afterthought routed back to an EARLIER answer, prepended to the
  // re-asked current question. `value` is the extracted content (e.g. "Fintech").
  amendedTopics: (value: string) => string;
  amendedBio: () => string;
}

const OB_EN: OnboardingStrings = {
  askGoal:
    "Welcome to Viva Tribe! I'll match you with humans at VivaTech.\n\n" +
    "2 quick questions — then you're set.\n\n" +
    '1/2 — what\'s your goal at VivaTech? One line. Like "meet European AI VCs", ' +
    '"sell to enterprise CFOs", or "find a co-founder".',
  needGoal: "Need one line on your goal. ",
  askEnergy:
    "2/2 — how do you like to meet people? Reply with one word:\n" +
    "• `1on1` — quiet 1-on-1 convos\n" +
    "• `group` — mixers, dinners, lounges\n" +
    "• `both`",
  needEnergy: "Reply `1on1`, `group`, or `both`. ",
  complete:
    "All set ✓\n\n" +
    "I'm pulling your professional profile from the web in the background — should be ready in a minute.\n\n" +
    "In the meantime, try:\n" +
    "• find me a buddy — someone to explore VivaTech with\n" +
    "• find me <topic> — specific people\n" +
    "• who is here\n" +
    "• free for 30",
  optedOut: "Opted out. You won't hear from me again. Reply anything to come back.",
  askSelfDo:
    "I couldn't auto-build your profile from the web, so 4 quick questions to match you well.\n\n" +
    "1/4 — In one line, what do you do?",
  needSelfDo: "One line on what you do. ",
  askSelfTopics:
    '2/4 — Your areas/topics? Comma-separated. E.g. "AI, climate, fintech".',
  needSelfTopics: "List a few, comma-separated. ",
  askSelfMeet: "3/4 — Who do you want to meet at VivaTech? One line.",
  needSelfMeet: "One line on who you want to meet. ",
  askSelfLinkedin:
    "4/4 — Your LinkedIn URL? People you ask to meet can check you out before saying yes. " +
    "Paste it, or reply skip.",
  needSelfLinkedin:
    "That didn't look like a LinkedIn URL. Paste a linkedin.com/in/… link, or reply skip. ",
  selfComplete:
    "All set ✓ Matching you now.\n\n" +
    "Try:\n" +
    "• find me a buddy\n" +
    "• find me <topic>\n" +
    "• who is here",
  amendedTopics: (value) => `Added ${value} to your topics. `,
  amendedBio: () => `Got it, updated what you do. `,
};

const OB_FR: OnboardingStrings = {
  askGoal:
    "Bienvenue dans Viva Tribe ! Je te mets en relation avec les bonnes personnes à VivaTech.\n\n" +
    "2 questions rapides — et c'est bon.\n\n" +
    "1/2 — quel est ton objectif à VivaTech ? En une ligne. Par ex. « rencontrer des VC IA européens », " +
    "« vendre à des DAF grands comptes », ou « trouver un·e cofondateur·rice ».",
  needGoal: "Donne-moi une ligne sur ton objectif. ",
  askEnergy:
    "2/2 — comment aimes-tu rencontrer les gens ? Réponds en un mot :\n" +
    "• `1on1` — échanges en tête-à-tête\n" +
    "• `group` — mixers, dîners, lounges\n" +
    "• `both` — les deux",
  needEnergy: "Réponds `1on1`, `group`, ou `both`. ",
  complete:
    "C'est tout bon ✓\n\n" +
    "Je récupère ton profil professionnel sur le web en arrière-plan — prêt dans une minute.\n\n" +
    "En attendant, essaie :\n" +
    "• trouve-moi un binôme — quelqu'un avec qui explorer VivaTech\n" +
    "• trouve-moi <sujet> — des personnes précises\n" +
    "• qui est là\n" +
    "• libre 30",
  optedOut:
    "Désinscrit·e. Tu ne recevras plus de messages. Réponds n'importe quoi pour revenir.",
  askSelfDo:
    "Je n'ai pas pu construire ton profil depuis le web, alors 4 questions rapides pour bien te matcher.\n\n" +
    "1/4 — En une ligne, que fais-tu ?",
  needSelfDo: "Une ligne sur ce que tu fais. ",
  askSelfTopics:
    '2/4 — Tes domaines/sujets ? Séparés par des virgules. Ex. « IA, climat, fintech ».',
  needSelfTopics: "Cites-en quelques-uns, séparés par des virgules. ",
  askSelfMeet: "3/4 — Qui veux-tu rencontrer à VivaTech ? En une ligne.",
  needSelfMeet: "Une ligne sur qui tu veux rencontrer. ",
  askSelfLinkedin:
    "4/4 — Ton URL LinkedIn ? Les personnes que tu demandes à rencontrer pourront te vérifier avant d'accepter. " +
    "Colle-la, ou réponds passer.",
  needSelfLinkedin:
    "Ça ne ressemblait pas à une URL LinkedIn. Colle un lien linkedin.com/in/…, ou réponds passer. ",
  selfComplete:
    "C'est tout bon ✓ Je te matche maintenant.\n\n" +
    "Essaie :\n" +
    "• trouve-moi un binôme\n" +
    "• trouve-moi <sujet>\n" +
    "• qui est là",
  amendedTopics: (value) => `${value} ajouté à tes domaines. `,
  amendedBio: () => `C'est noté, mis à jour. `,
};

function ob(lang: Lang): OnboardingStrings {
  return lang === "fr" ? OB_FR : OB_EN;
}

function parseEnergy(text: string): "1on1" | "group" | "both" | null {
  const t = text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["1on1", "1to1", "oneonone", "one"].includes(t)) return "1on1";
  if (["group", "mixer", "mixers", "social", "groupe"].includes(t)) return "group";
  if (["both", "all", "either", "lesdeux", "deux", "tous"].includes(t)) return "both";
  return null;
}

const SELF_STEPS: OnboardingStep[] = [
  "self_do",
  "self_topics",
  "self_meet",
  "self_linkedin",
];

function isSkipWord(text: string): boolean {
  return /^(skip|pass|passer|non|no|aucun|—|-)$/i.test(text.trim());
}

// Extract + normalize a LinkedIn profile URL from free text. Accepts a full or
// partial linkedin.com/in/… link (with or without scheme/subdomain). Returns
// null if nothing LinkedIn-shaped is found.
function parseLinkedinUrl(text: string): string | null {
  const m = text
    .trim()
    .match(/(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/[^\s]+/i);
  if (!m) return null;
  let url = m[0].replace(/[.,;]+$/, "");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url.slice(0, 300);
}

function parseTopics(text: string): string[] {
  return text
    .split(/[,\n;/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 6)
    .map((t) => t.slice(0, 40));
}

// Case-insensitive dedupe, preserving first-seen casing, capped at 6 topics.
function dedupeTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topics) {
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, 6);
}

// ── Afterthought / correction handling ──────────────────────────────────────
// The self-interview is a strict question-by-question machine. Without this, a
// reply like "Fintech as well" — meant as an addition to the EARLIER topics
// answer — gets blindly stored as the answer to whatever question is current
// (e.g. "who do you want to meet"), corrupting both fields.
//
// Cheap regex gate keeps the happy path 100% deterministic: only afterthought-
// shaped messages trigger the local zero-cost classifier, which decides which
// earlier field (if any) the message amends. Any classifier failure degrades
// silently to the normal deterministic flow (treat as the current answer).
export const AMENDMENT_GATE_RE =
  /\b(as well|also|too|forgot|in addition|on top)\b|^\s*(and|also|plus|oh,? and|btw|by the way|add)\b/i;

type AmendTarget = "current" | "bio" | "topics" | "meet";

const AMEND_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: { type: "string", enum: ["current", "bio", "topics", "meet"] },
    value: { type: "string" },
  },
  required: ["target", "value"],
};

// The field the CURRENT question is collecting — an "amendment" to this field is
// just a normal answer, so we treat that classifier verdict as "current".
function currentField(step: OnboardingStep): AmendTarget {
  if (step === "self_topics") return "topics";
  if (step === "self_meet") return "meet";
  return "current";
}

function currentQuestion(step: OnboardingStep, s: OnboardingStrings): string {
  return step === "self_topics" ? s.askSelfTopics : s.askSelfMeet;
}

export interface AmendmentVerdict {
  target: AmendTarget;
  value: string;
}

// Ask the local model whether `message` answers the current question or amends
// an earlier answer. Local-only (runStructured has no Anthropic fallback); on
// any error or empty result we return { target: "current" } so onboarding keeps
// working exactly as the deterministic path would.
export async function classifyAmendment(
  step: OnboardingStep,
  message: string,
  draftBio: string,
  draftTopics: string[]
): Promise<AmendmentVerdict> {
  const fallback: AmendmentVerdict = { target: "current", value: message };

  const currentQ =
    step === "self_topics"
      ? "their areas / topics of interest (a comma-separated list)"
      : "WHO they want to meet at the VivaTech conference";
  const earlier: string[] = [];
  if (draftBio) earlier.push(`- what they do: "${draftBio}"`);
  if (step === "self_meet" && draftTopics.length) {
    earlier.push(`- their areas/topics: ${draftTopics.join(", ")}`);
  }
  const allowed =
    step === "self_topics" ? `"current" or "bio"` : `"current", "bio", or "topics"`;

  const system =
    `You classify ONE message in a step-by-step profile intake for a networking bot. ` +
    `The bot just asked the user about: ${currentQ}.\n` +
    `Earlier in the intake the user already told us:\n` +
    `${earlier.join("\n") || "(nothing yet)"}\n\n` +
    `Decide what the latest message is:\n` +
    `- "current": it answers the CURRENT question. This is the DEFAULT — pick it unless the message is clearly an afterthought or correction about an EARLIER answer.\n` +
    `- "bio": it adds to or corrects WHAT THEY DO.\n` +
    `- "topics": it adds to or corrects THEIR AREAS / TOPICS.\n` +
    `Only ever output one of: ${allowed}. If unsure, output "current".\n\n` +
    `Also return "value": the content to file, with afterthought wording stripped.\n` +
    `Examples (topics question already answered, who-to-meet question current):\n` +
    `  "Fintech as well" -> {"target":"topics","value":"Fintech"}\n` +
    `  "oh and crypto too" -> {"target":"topics","value":"crypto"}\n` +
    `  "AI founders and climate VCs" -> {"target":"current","value":"AI founders and climate VCs"}\n` +
    `  "investors, also some operators" -> {"target":"current","value":"investors, operators"}\n` +
    `Output ONLY the JSON object.`;

  try {
    const { data } = await runStructured<AmendmentVerdict>({
      system: [system],
      user: message,
      schema: AMEND_SCHEMA,
      maxTokens: 120,
      timeoutMs: 6000,
    });
    const target: AmendTarget = ["current", "bio", "topics", "meet"].includes(data?.target)
      ? data.target
      : "current";
    const value = typeof data?.value === "string" && data.value.trim() ? data.value.trim() : message;
    return { target, value };
  } catch {
    return fallback;
  }
}

// Returns an outcome if the message was an afterthought routed to an earlier
// field (merged + current question re-asked); null if it's a genuine answer to
// the current question (caller proceeds with the deterministic step logic).
async function tryAmendPriorAnswer(
  userRef: DocumentReference,
  userDoc: UserDocLike,
  trimmed: string,
  step: OnboardingStep,
  lang: Lang
): Promise<OnboardingOutcome | null> {
  const s = ob(lang);
  const draftBio = userDoc.onboarding?.draftBio ?? "";
  const draftTopics = userDoc.onboarding?.draftTopics ?? [];

  const { target, value } = await classifyAmendment(step, trimmed, draftBio, draftTopics);

  // "current" (or an amendment to the field this question already collects) →
  // not an afterthought; let the deterministic step handle it.
  if (target === "current" || target === currentField(step) || !value.trim()) {
    return null;
  }

  if (target === "topics") {
    const merged = dedupeTopics([...draftTopics, ...parseTopics(value)]);
    // Deep-merge: leave step + other drafts untouched, just update the topics.
    await userRef.set({ onboarding: { draftTopics: merged } }, { merge: true });
    return {
      handled: true,
      reply: s.amendedTopics(value.slice(0, 40)) + currentQuestion(step, s),
    };
  }

  if (target === "bio") {
    const merged = (draftBio ? `${draftBio}; ` : "") + value;
    await userRef.set({ onboarding: { draftBio: merged.slice(0, 200) } }, { merge: true });
    return { handled: true, reply: s.amendedBio() + currentQuestion(step, s) };
  }

  return null;
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
  step: OnboardingStep,
  lang: Lang
): Promise<OnboardingOutcome> {
  const s = ob(lang);

  // Before treating this as the current question's answer, catch afterthoughts
  // that actually amend an EARLIER answer (e.g. "Fintech as well" at the
  // who-to-meet step really belongs in topics). Gated to the steps that have a
  // prior field to amend, and only when the message looks like an addition —
  // the common case stays a pure deterministic write.
  if (
    (step === "self_topics" || step === "self_meet") &&
    AMENDMENT_GATE_RE.test(trimmed)
  ) {
    const amended = await tryAmendPriorAnswer(userRef, userDoc, trimmed, step, lang);
    if (amended) return amended;
  }

  switch (step) {
    case "self_do": {
      const bio = trimmed.slice(0, 200);
      if (!bio) return { handled: true, reply: s.needSelfDo + s.askSelfDo };
      await userRef.set(
        { onboarding: { step: "self_topics", draftBio: bio } },
        { merge: true }
      );
      return { handled: true, reply: s.askSelfTopics };
    }

    case "self_topics": {
      const topics = parseTopics(trimmed);
      if (topics.length === 0) {
        return { handled: true, reply: s.needSelfTopics + s.askSelfTopics };
      }
      await userRef.set(
        { onboarding: { step: "self_meet", draftTopics: topics } },
        { merge: true }
      );
      return { handled: true, reply: s.askSelfMeet };
    }

    case "self_meet": {
      const matchSignals = trimmed.slice(0, 200);
      if (!matchSignals) {
        return { handled: true, reply: s.needSelfMeet + s.askSelfMeet };
      }
      await userRef.set(
        { onboarding: { step: "self_linkedin", draftMatchSignals: matchSignals } },
        { merge: true }
      );
      return { handled: true, reply: s.askSelfLinkedin };
    }

    case "self_linkedin": {
      let linkedinUrl: string | null = null;
      if (!isSkipWord(trimmed)) {
        linkedinUrl = parseLinkedinUrl(trimmed);
        // Non-skip, non-URL input → re-ask once rather than storing garbage.
        if (!linkedinUrl) {
          return { handled: true, reply: s.needSelfLinkedin + s.askSelfLinkedin };
        }
      }

      const draftBio = userDoc.onboarding?.draftBio ?? "";
      const draftTopics = userDoc.onboarding?.draftTopics ?? [];
      const draftMatchSignals = userDoc.onboarding?.draftMatchSignals ?? "";
      // Write into the same enrichment fields the matcher + web directory read.
      // source:"self" + publishable:true — self-reported data is authoritative,
      // so it's safe to publish and flips needsSelfProfile() back to false.
      // linkedinUrl mirrors what the enrichment worker would have stored, so
      // the intro-request flow can show it to people deciding whether to meet.
      await userRef.set(
        {
          enrichment: {
            status: "complete",
            source: "self",
            confidence: "self",
            publishable: true,
            bio: draftBio,
            topics: draftTopics,
            matchSignals: draftMatchSignals,
            linkedinUrl: linkedinUrl ?? null,
            completedAt: FieldValue.serverTimestamp(),
          },
          // Top-level mirror so linkedinUrlOf() finds it even if enrichment
          // is later overwritten by a web pass.
          ...(linkedinUrl ? { linkedinUrl } : {}),
          onboarding: {
            step: "complete",
            completedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
      return { handled: true, reply: s.selfComplete };
    }

    default:
      return { handled: false, reply: "" };
  }
}

export async function runOnboardingStep(
  userRef: DocumentReference,
  userDoc: UserDocLike,
  userMessage: string,
  lang: Lang = "en"
): Promise<OnboardingOutcome> {
  const trimmed = userMessage.trim();
  const step: OnboardingStep = userDoc.onboarding?.step ?? "pending";
  const s = ob(lang);

  // Universal escape hatch — `stop` always works.
  if (/^stop$|^arrêt|^arret/i.test(trimmed)) {
    await userRef.set(
      { status: "opted_out", optedOutAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { handled: true, reply: s.optedOut };
  }

  // In-chat self-profile interview already running — keep collecting answers.
  if (SELF_STEPS.includes(step)) {
    return runSelfInterview(userRef, userDoc, trimmed, step, lang);
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
    return { handled: true, reply: s.askSelfDo };
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
      return { handled: true, reply: s.askGoal };
    }

    case "ask_goal": {
      const goal = trimmed.slice(0, 240);
      if (!goal) {
        return { handled: true, reply: s.needGoal + s.askGoal };
      }
      // Use nested-object syntax — dot-notation keys in set({...}, {merge}) are
      // treated as LITERAL field names by the Admin SDK, not field paths.
      await userRef.set(
        { goal, onboarding: { step: "ask_energy" } },
        { merge: true }
      );
      return { handled: true, reply: s.askEnergy };
    }

    case "ask_energy": {
      const energy = parseEnergy(trimmed);
      if (!energy) {
        return { handled: true, reply: s.needEnergy + s.askEnergy };
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
      return { handled: true, reply: s.complete };
    }

    default: {
      // Unknown step — reset and re-ask.
      await userRef.set(
        { onboarding: { step: "pending" } },
        { merge: true }
      );
      return { handled: true, reply: s.askGoal };
    }
  }
}
