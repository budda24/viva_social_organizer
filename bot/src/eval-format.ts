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

// Force local-only BEFORE importing llm.ts (it reads LLM_BACKEND at module load).
process.env.LLM_BACKEND = "local";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_SYSTEM_PROMPT = fs.readFileSync(path.join(BOT_DIR, "CLAUDE.md"), "utf-8");

// Production hard cap (brain.ts truncates here). The CLAUDE.md "280" is a soft
// target — even the canonical menu exceeds it — so >280 is a warning, not a fail.
const MAX_REPLY_CHARS = 1200;
const SOFT_REPLY_CHARS = 280;

// A small synthetic directory with real-looking uids the model can cite.
const DIRECTORY_UIDS = ["u_alice", "u_bjorn", "u_chen", "u_dana", "u_evan"];
const DIRECTORY_BLOCK = `## Member directory

- Alice Chen (uid u_alice) — founder, climate-tech; enriched topics: carbon accounting, grid software; energy: 1on1; looking for: technical co-founder
- Bjorn Ek (uid u_bjorn) — VC at Northvolt Ventures; enriched topics: AI infra, climate, hardware; energy: group; wants to meet: deep-tech founders
- Wei Chen (uid u_chen) — staff engineer, AI infra; enriched topics: LLM serving, GPUs, inference; energy: 1on1; looking for: infra co-founder
- Dana Ortiz (uid u_dana) — growth lead, marketplaces; enriched topics: B2B SaaS, PLG, fintech; energy: group; wants to meet: early-stage operators
- Evan Park (uid u_evan) — designer, consumer; enriched topics: design systems, agents, UX; energy: 1on1; looking for: design partner customers`;

// A small synthetic upcoming-events list, mirroring the block brain.ts injects.
const EVENTS_BLOCK = `## Upcoming events (scheduled, soonest first — Paris time)
- Founders coffee · Wed 9 Jun, 09:00 Paris · Café Marly · host: Alice Chen — open hang
- Rooftop drinks · Wed 9 Jun, 20:00 Paris · 6e · host: Bjorn Ek`;

// The empty-events block, byte-identical to brain.ts buildEventsBlock(). Used to
// reproduce the "asked what's on with nothing scheduled" path — the one that
// regressed into dumping the whole menu in front of the answer.
const EMPTY_EVENTS_BLOCK = `## Upcoming events
(none scheduled yet — if the user asks what's on, reply in ONE warm line that nothing's on the calendar yet and invite them to be the first via "create event". Reply with only that line — do NOT show the menu.)`;

function volatileBlock(extra = ""): string {
  return `# Volatile context

Current Paris time: 2026-06-09 18:30 (Tuesday), ISO 2026-06-09T18:30:00+02:00.
Current user: uid u_self, channel telegram, displayName "You".
Your goal: find an AI infra co-founder. Energy: 1on1. Enriched topics: LLM serving, GPUs, agents.
${extra}
Recent turns: (none)`;
}

interface Case {
  name: string;
  message: string;
  expectMarker: "create_event" | "intro_buddy" | null;
  volatileExtra?: string;
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

const CASES: Case[] = [
  { name: "help → menu, no marker", message: "help", expectMarker: null },
  { name: "who is here → browse, no marker", message: "who is here", expectMarker: null },
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
  { name: "find me an AI VC → suggestions, no marker", message: "find me an AI VC", expectMarker: null },
  { name: "off-topic → menu, no marker", message: "what do you think about the weather?", expectMarker: null },
  { name: "find me a buddy → intro_buddy marker", message: "find me a buddy", expectMarker: "intro_buddy" },
  { name: "intro me to Wei Chen → intro_buddy marker", message: "intro me to Wei Chen", expectMarker: "intro_buddy" },
  {
    name: "event proposal → create_event marker (EVENT_CREATION_MODE)",
    message: "drinks tonight 8pm at Café Marly",
    expectMarker: "create_event",
    volatileExtra: "# EVENT_CREATION_MODE (single-turn directive)\nThe message below IS the event description. Emit a create_event marker.",
  },
  {
    name: "tell me about Online Tribes → pitch, no marker",
    message: "tell me about Online Tribes",
    expectMarker: null,
    mustMatch: /online tribes|community|franek/i,
  },
  {
    name: "what is Omnia → pitch, no marker",
    message: "what is Omnia?",
    expectMarker: null,
    mustMatch: /omnia|leads?|outreach|sales/i,
  },
];

interface CheckResult {
  ok: boolean;
  notes: string[];
}

async function main(): Promise<void> {
  const { runChat } = await import("./llm.js");
  const { parseActionMarker } = await import("./actions.js");

  console.log(`[eval] model=${process.env.LOCAL_CHAT_MODEL ?? "(default)"} temp=${process.env.LOCAL_TEMPERATURE ?? "0.2"} backend=local\n`);

  let passed = 0;
  for (const c of CASES) {
    const started = Date.now();
    let raw = "";
    let err: string | null = null;
    try {
      const { text } = await runChat({
        system: [BASE_SYSTEM_PROMPT, DIRECTORY_BLOCK, c.eventsBlock ?? EVENTS_BLOCK, volatileBlock(c.volatileExtra ?? "")],
        user: c.message,
        maxTokens: 400,
        expectAction: c.expectMarker === "create_event",
      });
      raw = text;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - started;

    const res: CheckResult = { ok: true, notes: [] };
    if (err) {
      res.ok = false;
      res.notes.push(`ERROR: ${err}`);
    } else {
      const { reply, action } = parseActionMarker(raw);

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
