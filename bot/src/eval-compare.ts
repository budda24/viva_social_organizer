/**
 * Multi-model comparison bench — quality vs performance on Tribu's real contract.
 *
 * Unlike eval-format.ts (the single-model production gate), this:
 *   - runs SEVERAL models back-to-back and prints a ranked scoreboard,
 *   - runs each case N times and reports a pass-RATE (reliability under temp),
 *   - adds FRENCH + adversarial (menu-leak / partial-name / verbosity) cases the
 *     production gate doesn't stress,
 *   - reports avg latency + >280-char (verbosity) rate as the "performance" axis.
 *
 * Forces LLM_BACKEND=local and LOCAL_THINK=false (Qwen3 must not emit <think>).
 *
 *   npx tsx src/eval-compare.ts --models qwen2.5:14b-instruct-q4_K_M,qwen3:14b,qwen3:30b-a3b-instruct-2507 --runs 3
 */

import "./env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LLM_BACKEND = "local";
if (process.env.LOCAL_THINK === undefined) process.env.LOCAL_THINK = "false";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_SYSTEM_PROMPT = fs.readFileSync(path.join(BOT_DIR, "CLAUDE.md"), "utf-8");

const MAX_REPLY_CHARS = 1200; // hard cap (brain truncates here)
const SOFT_REPLY_CHARS = 280; // verbosity warning threshold

const DIRECTORY_UIDS = ["u_alice", "u_bjorn", "u_chen", "u_dana", "u_evan"];
const DIRECTORY_BLOCK = `## Member directory

- Alice Chen (uid u_alice) — founder, climate-tech; enriched topics: carbon accounting, grid software; energy: 1on1; looking for: technical co-founder
- Bjorn Ek (uid u_bjorn) — VC at Northvolt Ventures; enriched topics: AI infra, climate, hardware; energy: group; wants to meet: deep-tech founders
- Wei Chen (uid u_chen) — staff engineer, AI infra; enriched topics: LLM serving, GPUs, inference; energy: 1on1; looking for: infra co-founder
- Dana Ortiz (uid u_dana) — growth lead, marketplaces; enriched topics: B2B SaaS, PLG, fintech; energy: group; wants to meet: early-stage operators
- Evan Park (uid u_evan) — designer, consumer; enriched topics: design systems, agents, UX; energy: 1on1; looking for: design partner customers`;

const EVENTS_BLOCK = `## Upcoming events (scheduled, soonest first — Paris time)
- Founders coffee · Wed 9 Jun, 09:00 Paris · Café Marly · host: Alice Chen — open hang
- Rooftop drinks · Wed 9 Jun, 20:00 Paris · 6e · host: Bjorn Ek`;

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
  expectMarker: "create_event" | "intro_buddy" | "edit_event" | null;
  volatileExtra?: string;
  mustMatch?: RegExp;
  mustNotMatch?: RegExp;
  eventsBlock?: string;
  expectTargetUid?: string; // for intro_buddy: assert the exact resolved member
}

const MENU_FINGERPRINT =
  /find me a buddy|who is here|free for 30|opt out|see this menu|trouve-moi|qui est l|opt(?:e|er) out/i;
const DIR_NAME = /alice|bjorn|wei|dana|evan/i;

const CASES: Case[] = [
  // ── core English contract (mirrors the production gate) ──────────────────
  { name: "EN help → menu", message: "help", expectMarker: null, mustMatch: MENU_FINGERPRINT },
  { name: "EN who is here → browse", message: "who is here", expectMarker: null, mustMatch: DIR_NAME, mustNotMatch: MENU_FINGERPRINT },
  {
    name: "EN what's on → lists events",
    message: "which is the upcoming events?",
    expectMarker: null,
    mustMatch: /founders coffee|rooftop drinks|caf[ée] marly|09:00|20:00/i,
    mustNotMatch: MENU_FINGERPRINT,
  },
  {
    name: "EN what's on, none → invite, no menu",
    message: "any events coming up?",
    expectMarker: null,
    eventsBlock: EMPTY_EVENTS_BLOCK,
    mustMatch: /create event|be the first|nothing.*(?:calendar|scheduled|yet)|no events?/i,
    mustNotMatch: MENU_FINGERPRINT,
  },
  { name: "EN find me an AI VC → browse", message: "find me an AI VC", expectMarker: null },
  { name: "EN off-topic weather → menu", message: "what do you think about the weather?", expectMarker: null, mustMatch: MENU_FINGERPRINT },
  { name: "EN find me a buddy → intro_buddy", message: "find me a buddy", expectMarker: "intro_buddy" },
  { name: "EN intro me to Wei Chen → intro_buddy(u_chen)", message: "intro me to Wei Chen", expectMarker: "intro_buddy", expectTargetUid: "u_chen" },
  {
    name: "EN event proposal → create_event",
    message: "drinks tonight 8pm at Café Marly",
    expectMarker: "create_event",
    volatileExtra: "# EVENT_CREATION_MODE (single-turn directive)\nThe message below IS the event description. Emit a create_event marker.",
  },
  {
    name: "EN edit → edit_event",
    message: "move it to 9am",
    expectMarker: "edit_event",
    volatileExtra:
      "# EDIT_EVENT_MODE (single-turn directive)\n" +
      "The user hosts this event and is describing a change. Apply ONLY what they ask.\n" +
      "Current event:\n- title: Founders coffee\n- kind: coffee\n- starts (ISO): 2026-06-09T08:00:00+02:00\n- neighborhood: 1er\n- full address: Café Marly\n- capacity: unlimited\n" +
      'Reply with a one-line preview then an `edit_event` marker {"kind":"edit_event","changes":{...}} carrying only changed fields. Do NOT include an eventId.',
  },
  { name: "EN about Online Tribes → pitch", message: "tell me about Online Tribes", expectMarker: null, mustMatch: /online tribes|community|franek/i, mustNotMatch: MENU_FINGERPRINT },
  { name: "EN about Omnia → pitch", message: "what is Omnia?", expectMarker: null, mustMatch: /omnia|leads?|outreach|sales/i, mustNotMatch: MENU_FINGERPRINT },

  // ── French (the bot is EN/FR; the production gate never tests this) ───────
  { name: "FR qui est là → browse", message: "qui est là ?", expectMarker: null, mustMatch: DIR_NAME },
  {
    name: "FR quels événements → lists events",
    message: "quels sont les événements à venir ?",
    expectMarker: null,
    mustMatch: /founders coffee|rooftop drinks|caf[ée] marly|09:00|20:00/i,
    mustNotMatch: MENU_FINGERPRINT,
  },
  { name: "FR présente-moi Wei Chen → intro_buddy(u_chen)", message: "présente-moi Wei Chen", expectMarker: "intro_buddy", expectTargetUid: "u_chen" },
  { name: "FR c'est quoi Omnia → pitch", message: "c'est quoi Omnia ?", expectMarker: null, mustMatch: /omnia/i },
  {
    name: "FR proposition d'event → create_event",
    message: "un verre ce soir à 20h au Café Marly",
    expectMarker: "create_event",
    volatileExtra: "# EVENT_CREATION_MODE (single-turn directive)\nThe message below IS the event description. Emit a create_event marker.",
  },

  // ── adversarial (verbosity / partial name / menu-leak temptation) ────────
  { name: "ADV partial name 'intro me to Wei' → u_chen", message: "intro me to Wei", expectMarker: "intro_buddy", expectTargetUid: "u_chen" },
  {
    name: "ADV answerable+polite → no menu staple",
    message: "could you please show me the events? thanks so much!",
    expectMarker: null,
    mustMatch: /founders coffee|rooftop drinks|09:00|20:00/i,
    mustNotMatch: MENU_FINGERPRINT,
  },
  { name: "ADV pure greeting → menu alone", message: "heyyy 😊", expectMarker: null, mustMatch: MENU_FINGERPRINT },
];

interface ModelScore {
  model: string;
  runs: number;
  totalChecks: number;
  passed: number;
  softViolations: number; // replies > 280 chars
  latencies: number[];
  errors: number;
  perCaseFails: Map<string, number>;
}

function checkOne(c: Case, raw: string, parse: (t: string) => { reply: string; action: any }): string[] {
  const notes: string[] = [];
  const { reply, action } = parse(raw);
  if (reply.length > MAX_REPLY_CHARS) notes.push(`>hardcap(${reply.length})`);
  if (/^\s*#{1,6}\s/m.test(reply) || /\*\*/.test(reply) || /^\s*\*\s/m.test(reply)) notes.push("markdown");
  if (/<think>|<\/think>/i.test(raw)) notes.push("think-leak");
  if (c.expectMarker) {
    if (!action) notes.push(`no ${c.expectMarker}`);
    else if (action.kind !== c.expectMarker) notes.push(`got ${action.kind}`);
    else if (c.expectMarker === "intro_buddy") {
      const uid = (action as { targetUid?: string }).targetUid ?? "";
      if (!DIRECTORY_UIDS.includes(uid)) notes.push(`bad uid ${uid}`);
      else if (c.expectTargetUid && uid !== c.expectTargetUid) notes.push(`uid ${uid}≠${c.expectTargetUid}`);
    }
  } else if (action) {
    notes.push(`unexpected ${action.kind}`);
  }
  if (c.mustMatch && !c.mustMatch.test(reply)) notes.push("missed mustMatch");
  if (c.mustNotMatch && c.mustNotMatch.test(reply)) notes.push("hit mustNotMatch");
  return notes;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelsArg = argv[argv.indexOf("--models") + 1] ?? "qwen2.5:14b-instruct-q4_K_M,qwen3:14b,qwen3:30b-a3b-instruct-2507";
  const runs = Number(argv[argv.indexOf("--runs") + 1] ?? 3);
  const models = modelsArg.split(",").map((m) => m.trim()).filter(Boolean);

  const { parseActionMarker } = await import("./actions.js");

  const scores: ModelScore[] = [];
  for (const model of models) {
    process.env.LOCAL_CHAT_MODEL = model;
    // Per-model thinking strategy (Ollama 0.24.0 quirks):
    //   - qwen3 MoE (a3b): think:false leaks CoT into content → use /no_think tag, omit param.
    //   - qwen3 dense:     think:false param works cleanly.
    //   - qwen2.5 / other: not a thinking model → omit param.
    const isQwen3 = /qwen3/i.test(model);
    const isMoE = /a3b/i.test(model);
    const useNoThinkTag = isQwen3 && isMoE;
    if (isQwen3 && !isMoE) process.env.LOCAL_THINK = "false";
    else delete process.env.LOCAL_THINK;
    // Re-import llm.js fresh so it picks up the new LOCAL_CHAT_MODEL + LOCAL_THINK (read at load).
    const llm = await import(`./llm.js?model=${encodeURIComponent(model)}&t=${useNoThinkTag ? "tag" : process.env.LOCAL_THINK ?? "none"}`);
    const score: ModelScore = {
      model, runs, totalChecks: 0, passed: 0, softViolations: 0, latencies: [], errors: 0, perCaseFails: new Map(),
    };
    console.log(`\n══ ${model} (${runs} runs × ${CASES.length} cases) ══`);
    for (let r = 0; r < runs; r++) {
      for (const c of CASES) {
        score.totalChecks++;
        const started = Date.now();
        try {
          const { text } = await llm.runChat({
            system: [
              BASE_SYSTEM_PROMPT + (useNoThinkTag ? "\n\n/no_think" : ""),
              DIRECTORY_BLOCK, c.eventsBlock ?? EVENTS_BLOCK, volatileBlock(c.volatileExtra ?? ""),
            ],
            user: c.message,
            maxTokens: 400,
            expectAction: c.expectMarker === "create_event" || c.expectMarker === "edit_event",
            timeoutMs: 180_000,
          });
          score.latencies.push(Date.now() - started);
          const { reply } = parseActionMarker(text);
          if (reply.length > SOFT_REPLY_CHARS) score.softViolations++;
          const notes = checkOne(c, text, parseActionMarker);
          if (notes.length === 0) score.passed++;
          else score.perCaseFails.set(c.name, (score.perCaseFails.get(c.name) ?? 0) + 1);
        } catch (e) {
          score.errors++;
          score.latencies.push(Date.now() - started);
          score.perCaseFails.set(c.name, (score.perCaseFails.get(c.name) ?? 0) + 1);
        }
      }
      process.stdout.write(`  run ${r + 1}/${runs} done\n`);
    }
    scores.push(score);
  }

  console.log(`\n\n════════ SCOREBOARD (${runs} runs × ${CASES.length} cases) ════════`);
  console.log("model".padEnd(38), "pass%".padStart(7), "avg ms".padStart(8), "p50 ms".padStart(8), ">280%".padStart(7), "errs".padStart(5));
  for (const s of scores) {
    const pass = ((s.passed / s.totalChecks) * 100).toFixed(1);
    const avg = Math.round(s.latencies.reduce((a, b) => a + b, 0) / (s.latencies.length || 1));
    const soft = ((s.softViolations / s.totalChecks) * 100).toFixed(0);
    console.log(
      s.model.padEnd(38),
      `${pass}%`.padStart(7),
      `${avg}`.padStart(8),
      `${median(s.latencies)}`.padStart(8),
      `${soft}%`.padStart(7),
      `${s.errors}`.padStart(5),
    );
  }
  console.log("\nRepeated failures by case (count across all runs):");
  for (const s of scores) {
    const fails = [...s.perCaseFails.entries()].sort((a, b) => b[1] - a[1]);
    if (!fails.length) { console.log(`  ${s.model}: clean ✅`); continue; }
    console.log(`  ${s.model}:`);
    for (const [name, n] of fails) console.log(`      ${n}× ${name}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
