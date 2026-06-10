/**
 * Offline format eval — does the LOCAL model honor Tribu's output contract?
 *
 * Runs a set of representative messages through the local backend with the REAL
 * system prompt (bot/CLAUDE.md) + a synthetic member directory, and checks:
 *   - reply ≤ 280 chars (the CLAUDE.md hard limit)
 *   - no markdown (headers / **bold** / "* " bullets)
 *   - a valid action marker appears exactly when one is expected
 *   - intro_buddy.targetUid is lifted verbatim from the directory
 *
 * This is the gate before trusting the local model in production. It forces
 * LLM_BACKEND=local (no Anthropic fallback) so failures are the LOCAL model's,
 * not masked by Haiku. Needs no Firestore.
 *
 *   npx tsx src/eval-format.ts
 *   LOCAL_CHAT_MODEL=qwen2.5:32b-instruct-q4_K_M LOCAL_TEMPERATURE=0.2 npx tsx src/eval-format.ts
 */

import "./env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Force the backend BEFORE importing llm.ts (it reads LLM_BACKEND at module load).
// Defaults to local-only (the production-gate use), but EVAL_BACKEND lets us A/B
// a frontier model, e.g. EVAL_BACKEND=anthropic CLAUDE_MODEL=claude-haiku-4-5.
process.env.LLM_BACKEND = process.env.EVAL_BACKEND ?? "local";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_SYSTEM_PROMPT = fs.readFileSync(path.join(BOT_DIR, "CLAUDE.md"), "utf-8");

// Production hard cap (brain.ts truncates here). The CLAUDE.md "280" is a soft
// target — even the canonical menu exceeds it — so >280 is a warning, not a fail.
const MAX_REPLY_CHARS = 1200;
const SOFT_REPLY_CHARS = 280;

// A small synthetic directory with real-looking uids the model can cite.
const DIRECTORY_UIDS = ["u_alice", "u_bjorn", "u_chen", "u_dana", "u_evan", "u_sam"];
const DIRECTORY_BLOCK = `## Member directory

- Alice Chen (uid u_alice) — founder, climate-tech; enriched topics: carbon accounting, grid software; energy: 1on1; looking for: technical co-founder
- Bjorn Ek (uid u_bjorn) — VC at Northvolt Ventures; enriched topics: AI infra, climate, hardware; energy: group; wants to meet: deep-tech founders
- Wei Chen (uid u_chen) — staff engineer, AI infra; enriched topics: LLM serving, GPUs, inference; energy: 1on1; looking for: infra co-founder
- Dana Ortiz (uid u_dana) — growth lead, marketplaces; enriched topics: B2B SaaS, PLG, fintech; energy: group; wants to meet: early-stage operators
- Evan Park (uid u_evan) — designer, consumer; enriched topics: design systems, agents, UX; energy: 1on1; looking for: design partner customers
- Sam Rivera (uid u_sam) — founder, climate-fintech startup; enriched topics: carbon markets, payments; energy: 1on1; wants to meet: climate VCs, carbon-market experts`;

// A small synthetic upcoming-events list, mirroring the block brain.ts injects.
const EVENTS_BLOCK = `## Upcoming events (scheduled, soonest first — Paris time)
- Founders coffee · Wed 9 Jun, 09:00 Paris · Café Marly · host: Alice Chen — open hang
- Rooftop drinks · Wed 9 Jun, 20:00 Paris · 6e · host: Bjorn Ek`;

// The empty-events block, byte-identical to brain.ts buildEventsBlock(). Used to
// reproduce the "asked what's on with nothing scheduled" path — the one that
// regressed into dumping the whole menu in front of the answer.
const EMPTY_EVENTS_BLOCK = `## Upcoming events
(none scheduled yet — if the user asks what's on, reply in ONE warm line that nothing's on the calendar yet and invite them to be the first via "create event". Reply with only that line — do NOT show the menu.)`;

function volatileBlock(extra = "", noInterests = false): string {
  // Production omits the goal/topics lines entirely when the user has none on
  // file (enrichment pending / empty profile) — mirror that for the buddy
  // no-interest path so the model sees exactly what it would in prod.
  const self = noInterests
    ? ""
    : `Your goal: find an AI infra co-founder. Energy: 1on1. Enriched topics: LLM serving, GPUs, agents.\n`;
  return `# Volatile context

Current Paris time: 2026-06-09 18:30 (Tuesday), ISO 2026-06-09T18:30:00+02:00.
Current user: uid u_self, channel telegram, displayName "You".
${self}${extra}
Recent turns: (none)`;
}

interface Case {
  name: string;
  message: string;
  expectMarker:
    | "create_event"
    | "intro_buddy"
    | "edit_event"
    | "share_founder_contact"
    | null;
  volatileExtra?: string;
  // Drop the user's goal/topics from the volatile block (simulates a profile
  // with no interests on file — enrichment pending / empty).
  noInterests?: boolean;
  // If set, the reply must match this (e.g. a venture pitch, not the menu).
  mustMatch?: RegExp;
  // If set, the reply must NOT match this (e.g. the menu bundled with an answer).
  mustNotMatch?: RegExp;
  // Override the events block for this case (defaults to the populated one).
  eventsBlock?: string;
}

// Distinctive menu lines — if any appear, the model dumped the menu. Used to
// assert the menu is NOT stapled onto a reply that already answered.
const MENU_FINGERPRINT = /find me a buddy|who is here|free for 30|opt out|see this menu/i;

// A claim that a side effect ALREADY happened. For cancel/edit messages where
// the user hosts nothing — and which the harness, not the LLM, executes — any of
// these in the LLM's free text is a fabricated success (the hallucination hole).
// The safe replies (the menu, or "I can't do that directly") contain none of
// these: the menu says "cancel"/"create", not "cancelled"/"created".
const SUCCESS_CLAIM =
  /\b(cancell?ed|scrapped|deleted|removed|calls?\s+off|called\s+off|moved|updated|booked|scheduled|pinged|all set)\b|c['’]est\s+(annul[ée]e?|fait|cr[ée]{1,2})|\bannul[ée]e?\b/i;

const CASES: Case[] = [
  { name: "help → menu, no marker", message: "help", expectMarker: null },
  { name: "who is here → browse, no marker", message: "who is here", expectMarker: null },
  {
    // Shah (Jun 8 19:24): "asked for the pinging members but the menu appeared."
    // "who did you ping" = who's in the circle → list members, never the menu.
    name: "who did you ping → lists members, not the menu",
    message: "who did you ping?",
    expectMarker: null,
    mustMatch: /alice|bjorn|wei|dana|evan|sam/i,
    mustNotMatch: MENU_FINGERPRINT,
  },
  {
    name: "what's on → lists events, no marker",
    message: "which is the upcoming events?",
    expectMarker: null,
    // Must surface a real event from the block, not the menu / a hallucination.
    mustMatch: /founders coffee|rooftop drinks|caf[ée] marly|09:00|20:00/i,
    mustNotMatch: MENU_FINGERPRINT,
  },
  {
    name: "what's on, no events → invites create, no menu dump",
    message: "which is the upcoming events?",
    expectMarker: null,
    eventsBlock: EMPTY_EVENTS_BLOCK,
    // Should say there's nothing scheduled and point at create event…
    mustMatch: /create event|be the first|nothing.*(?:calendar|scheduled|yet)|no events?/i,
    // …WITHOUT stapling the whole menu in front of the answer (the regressed bug).
    mustNotMatch: MENU_FINGERPRINT,
  },
  {
    // Role direction: the only VC in the directory (Bjorn) is a climate/deep-tech
    // fund, not clearly an AI VC — so surfacing him OR honestly saying "no exact AI
    // VC, want a buddy?" are both fine. What must NEVER happen: matching Wei, an
    // AI-infra ENGINEER, just because the AI topic overlaps. That's the bug.
    name: "find me an AI VC → never the AI engineer",
    message: "find me an AI VC",
    expectMarker: null,
    mustNotMatch: /wei chen|u_chen/i,
  },
  {
    // Regression for the live role-blind bug: "climate VC" must pick the climate
    // INVESTOR (Bjorn, VC at Northvolt, climate in topics), NOT a climate FOUNDER
    // (Alice) and NOT Sam — a founder whose "wants to meet: climate VCs" is the
    // inverse direction (he's hunting a VC, he isn't one). Both are wrong-way matches.
    name: "find me a climate VC → the VC, not a founder seeking VCs",
    message: "find me a climate VC",
    expectMarker: null,
    mustMatch: /bjorn|northvolt/i,
    mustNotMatch: /alice|sam rivera/i,
  },
  { name: "off-topic → menu, no marker", message: "what do you think about the weather?", expectMarker: null },
  // NOTE: `find me a buddy` is no longer an LLM case. It's handled by a
  // deterministic ranker (rankBuddies) upstream of the model — it returns several
  // interest-ranked matches, each with a Connect button, and never reaches the
  // LLM (so no intro_buddy marker here). The ranker + formatting are validated
  // live, against the real directory, by test-buddy-live.ts. The typed
  // `intro me to <name>` verb below is still an LLM/marker path.
  { name: "intro me to Wei Chen → intro_buddy marker", message: "intro me to Wei Chen", expectMarker: "intro_buddy" },
  {
    name: "event proposal → create_event marker (EVENT_CREATION_MODE)",
    message: "drinks tonight 8pm at Café Marly",
    expectMarker: "create_event",
    volatileExtra: "# EVENT_CREATION_MODE (single-turn directive)\nThe message below IS the event description. Emit a create_event marker.",
  },
  {
    name: "edit change → edit_event marker (EDIT_EVENT_MODE)",
    message: "move it to 9am",
    expectMarker: "edit_event",
    volatileExtra:
      "# EDIT_EVENT_MODE (single-turn directive)\n" +
      "The user hosts this event and is describing a change. Apply ONLY what they ask.\n" +
      "Current event:\n- title: Founders coffee\n- kind: coffee\n- starts (ISO): 2026-06-09T08:00:00+02:00\n- neighborhood: 1er\n- full address: Café Marly\n- capacity: unlimited\n" +
      'Reply with a one-line preview then an `edit_event` marker {"kind":"edit_event","changes":{...}} carrying only changed fields. Do NOT include an eventId.',
  },
  {
    // A venture pitch now ends with a founder-contact offer + a
    // share_founder_contact marker (the harness sends contacts on the Yes button).
    name: "tell me about Online Tribes → pitch + founder-contact marker",
    message: "tell me about Online Tribes",
    expectMarker: "share_founder_contact",
    mustMatch: /online tribes|community|franek/i,
  },
  {
    name: "what is Omnia → pitch + founder-contact marker",
    message: "what is Omnia?",
    expectMarker: "share_founder_contact",
    mustMatch: /omnia|leads?|outreach|sales/i,
  },
  // ── Hallucination guardrail: cancel/edit when the user hosts NO event ───────
  // u_self hosts nothing (every event in the block is someone else's), and
  // cancel/edit are harness-handled. So if a phrasing falls through to the LLM,
  // it must NOT fabricate a completed action — it should deflect (menu / "I
  // can't do that directly"), never claim success.
  {
    name: "cancel, no event hosted → no fabricated success",
    message: "cancel my breakfast event",
    expectMarker: null,
    mustNotMatch: SUCCESS_CLAIM,
  },
  {
    name: "unmatched cancel verb 'scrap' → no fabricated success",
    message: "scrap my breakfast event",
    expectMarker: null,
    mustNotMatch: SUCCESS_CLAIM,
  },
  {
    name: "unmatched cancel verb 'call off' → no fabricated success",
    message: "call off the dinner I'm hosting tomorrow",
    expectMarker: null,
    mustNotMatch: SUCCESS_CLAIM,
  },
  {
    name: "edit, no event + not in EDIT mode → no fabricated success",
    message: "change the time of my dinner to 9pm",
    expectMarker: null,
    mustNotMatch: SUCCESS_CLAIM,
  },
];

interface CheckResult {
  ok: boolean;
  notes: string[];
}

async function main(): Promise<void> {
  const { runChat } = await import("./llm.js");
  const { parseActionMarker } = await import("./actions.js");
  // Import the REAL production guardrails so the eval validates the system
  // (model + harness), not just the raw model output.
  const { isTopicBrowse, guardFabricatedSuccess, investorRoleDirective, whoPingedDirective, isBuddyIntent } = await import("./brain.js");
  const { msg } = await import("./i18n.js");

  const backend = process.env.LLM_BACKEND ?? "local";
  const model =
    backend === "anthropic"
      ? (process.env.CLAUDE_MODEL ?? "claude-haiku-4-5")
      : (process.env.LOCAL_CHAT_MODEL ?? "(default)");
  console.log(`[eval] model=${model} temp=${process.env.LOCAL_TEMPERATURE ?? "0.2"} backend=${backend}\n`);

  let passed = 0;
  for (const c of CASES) {
    const started = Date.now();
    let raw = "";
    let err: string | null = null;
    try {
      // Mirror the production harness short-circuit: a buddy request with no
      // interests on file is answered deterministically (ask), never sent to the model.
      if (isBuddyIntent(c.message) && (c.noInterests ?? false)) {
        raw = msg("en").buddyAskInterest;
      } else {
        const directives = [
          investorRoleDirective(c.message),
          whoPingedDirective(c.message),
        ].filter(Boolean);
        const { text } = await runChat({
          system: [
            BASE_SYSTEM_PROMPT,
            DIRECTORY_BLOCK,
            c.eventsBlock ?? EVENTS_BLOCK,
            volatileBlock(c.volatileExtra ?? "", c.noInterests ?? false),
            ...directives,
          ],
          user: c.message,
          maxTokens: 400,
          expectAction:
            c.expectMarker === "create_event" ||
            c.expectMarker === "edit_event" ||
            c.expectMarker === "share_founder_contact",
        });
        raw = text;
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - started;

    const res: CheckResult = { ok: true, notes: [] };
    if (err) {
      res.ok = false;
      res.notes.push(`ERROR: ${err}`);
    } else {
      let { reply, action } = parseActionMarker(raw);

      // Mirror the production post-Claude backstops so the eval measures what the
      // USER actually gets (model + guardrails): drop out-of-mode and topic-browse
      // markers, then swallow any fabricated success. A raw model may still
      // hallucinate "Cancelled." — the system must not surface it.
      const inEditMode = (c.volatileExtra ?? "").includes("EDIT_EVENT_MODE");
      const inEventMode = (c.volatileExtra ?? "").includes("EVENT_CREATION_MODE");
      if (action?.kind === "edit_event" && !inEditMode) action = null;
      if (action?.kind === "create_event" && !inEventMode) action = null;
      if (action?.kind === "intro_buddy" && isTopicBrowse(c.message)) action = null;
      reply = guardFabricatedSuccess(reply, !!action, "en");

      if (reply.length > MAX_REPLY_CHARS) {
        res.ok = false;
        res.notes.push(`reply ${reply.length} chars > hard cap ${MAX_REPLY_CHARS}`);
      } else if (reply.length > SOFT_REPLY_CHARS) {
        res.notes.push(`WARN: ${reply.length} chars > soft target ${SOFT_REPLY_CHARS}`);
      }
      if (/^\s*#{1,6}\s/m.test(reply) || /\*\*/.test(reply) || /^\s*\*\s/m.test(reply)) {
        res.ok = false;
        res.notes.push("markdown detected (header/bold/* bullet)");
      }
      if (c.expectMarker) {
        if (!action) {
          res.ok = false;
          res.notes.push(`expected ${c.expectMarker} marker, got none`);
        } else if (action.kind !== c.expectMarker) {
          res.ok = false;
          res.notes.push(`expected ${c.expectMarker}, got ${action.kind}`);
        } else if (action.kind === "intro_buddy") {
          const uid = (action as { targetUid?: string }).targetUid ?? "";
          if (!DIRECTORY_UIDS.includes(uid)) {
            res.ok = false;
            res.notes.push(`intro_buddy.targetUid "${uid}" not in directory`);
          }
        }
      } else if (action) {
        res.ok = false;
        res.notes.push(`unexpected ${action.kind} marker on a no-marker case`);
      }
      if (c.mustMatch && !c.mustMatch.test(reply)) {
        res.ok = false;
        res.notes.push(`reply didn't match ${c.mustMatch} (likely menu'd instead of pitched)`);
      }
      if (c.mustNotMatch && c.mustNotMatch.test(reply)) {
        res.ok = false;
        res.notes.push(`reply matched ${c.mustNotMatch} (menu bundled with the answer)`);
      }
    }

    if (res.ok) passed++;
    const tag = res.ok ? "PASS" : "FAIL";
    console.log(`[${tag}] ${c.name}  (${ms}ms)`);
    if (res.notes.length) console.log(`        ${res.notes.join(" | ")}`);
    if (!res.ok && raw) console.log(`        reply: ${raw.replace(/\n/g, " ").slice(0, 200)}`);
  }

  console.log(`\n[eval] ${passed}/${CASES.length} passed`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
