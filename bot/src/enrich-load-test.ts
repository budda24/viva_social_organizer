/**
 * Concurrency load test for the LOCAL, FREE enrichment pipeline.
 *
 * IMPORTANT context: a deployed Cloud Function (functions/src/users/enrich.ts,
 * `enrichUser`) triggers on any `users/{uid}` write with enrichment.status =
 * "pending" and wins the claim race against the laptop brain's 5s poll. That CF
 * uses the paid Anthropic API (Sonnet 4.6 + web_search). To test the LOCAL free
 * path (SearXNG + Qwen via Ollama structured output) without the CF stealing the
 * job -- and without spending a cent -- this harness calls the brain's actual
 * local enrichment function (`runLocalEnrich`) IN-PROCESS. No Firestore writes,
 * so the CF never triggers. Same code the laptop brain runs in pure-local mode.
 *
 *   npx tsx src/enrich-load-test.ts --count 3                         # warm-up
 *   npx tsx src/enrich-load-test.ts --count 20 --concurrency 4        # overwhelm
 *   npx tsx src/enrich-load-test.ts --count 20 --names synthetic      # sad-path stress
 *
 * Flags:
 *   --count N         how many enrichments to run (default 3)
 *   --concurrency C   how many to run at once (default 4) -- the real knob for
 *                     "overwhelming" SearXNG + the single Ollama runner
 *   --names MODE      real (default) | synthetic | mix  (see pools below)
 *
 * Cost: $0. Hits SearXNG (localhost) + Ollama (localhost) only -- never Anthropic.
 */

import "./env.js";
import { runLocalEnrich, type EnrichmentInput, type EnrichmentResult } from "./enrich.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const COUNT = Number(arg("count", "3"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const NAMES_MODE = (arg("names", "real") ?? "real") as "real" | "synthetic" | "mix";
const DUMP = process.argv.includes("--dump"); // print full enrichment per person for quality review

// Mirrors enrich.ts MIN_PUBLISHABLE_CONFIDENCE = "medium".
function passesGate(c: string): boolean {
  return c === "high" || c === "medium";
}

interface Seed {
  displayName: string;
  email: string;
  linkedinHeadline: string;
  city: string;
}

// Real, heavily-public European tech founders/VCs. SearXNG returns LinkedIn-
// anchored hits, so the local pipeline can reach medium/high confidence.
const REAL_SEEDS: Seed[] = [
  { displayName: "Guillaume Moubeche", email: "guillaume@lemlist.com", linkedinHeadline: "Co-founder & CEO at lemlist", city: "Paris" },
  { displayName: "Pauline Roux", email: "pauline@elaia.com", linkedinHeadline: "Partner at Elaia Partners", city: "Paris" },
  { displayName: "Roxanne Varza", email: "roxanne@stationf.co", linkedinHeadline: "Director at Station F", city: "Paris" },
  { displayName: "Rand Hindi", email: "rand@zama.ai", linkedinHeadline: "Co-founder & CEO at Zama", city: "Paris" },
  { displayName: "Clement Delangue", email: "clem@huggingface.co", linkedinHeadline: "Co-founder & CEO at Hugging Face", city: "Paris" },
  { displayName: "Alexandre Lebrun", email: "alex@nabla.com", linkedinHeadline: "Co-founder & CEO at Nabla", city: "Paris" },
  { displayName: "Julie Bourgein", email: "julie@partech.com", linkedinHeadline: "Investor at Partech", city: "Paris" },
  { displayName: "Arthur Mensch", email: "arthur@mistral.ai", linkedinHeadline: "Co-founder & CEO at Mistral AI", city: "Paris" },
  { displayName: "Pierre Entremont", email: "pierre@frst.vc", linkedinHeadline: "Co-founder at Frst Capital", city: "Paris" },
  { displayName: "Nina Achadjian", email: "nina@indexventures.com", linkedinHeadline: "Partner at Index Ventures", city: "London" },
  { displayName: "Harry Stebbings", email: "harry@20vc.com", linkedinHeadline: "Founder at 20VC", city: "London" },
  { displayName: "Taavet Hinrikus", email: "taavet@plural.vc", linkedinHeadline: "Co-founder at Plural, co-founder Wise", city: "London" },
];

// Plausible-but-fake -> mostly low/none confidence. Exercises the sad path and
// raw search+synth throughput.
const SYNTH_FIRST = ["Marta", "Ivan", "Sofia", "Lukas", "Elena", "Tomas", "Greta", "Nikolai", "Ada", "Bruno"];
const SYNTH_LAST = ["Kowalczyk", "Petrov", "Nilsson", "Vandenberg", "Rossi", "Haas", "Lindqvist", "Moreau", "Kovac", "Ferreira"];
const SYNTH_HEADLINES = [
  "Founder at a stealth devtools startup",
  "Early-stage VC focused on climate",
  "Building agents at a seed-stage company",
  "Growth lead at a B2B SaaS scaleup",
  "Hardware engineer, ex-bigtech",
];
const SYNTH_CITIES = ["Berlin", "Amsterdam", "Stockholm", "Lisbon", "Warsaw", "Madrid"];

function syntheticSeed(i: number): Seed {
  const first = SYNTH_FIRST[i % SYNTH_FIRST.length];
  const last = SYNTH_LAST[(i * 7 + 3) % SYNTH_LAST.length];
  return {
    displayName: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example-startup-${i}.com`,
    linkedinHeadline: SYNTH_HEADLINES[i % SYNTH_HEADLINES.length],
    city: SYNTH_CITIES[i % SYNTH_CITIES.length],
  };
}

function buildSeed(i: number): Seed {
  if (NAMES_MODE === "synthetic") return syntheticSeed(i);
  if (NAMES_MODE === "real") return REAL_SEEDS[i % REAL_SEEDS.length];
  return i % 2 === 0 ? REAL_SEEDS[(i >> 1) % REAL_SEEDS.length] : syntheticSeed(i);
}

interface JobOutcome {
  name: string;
  ok: boolean;
  ms: number;
  confidence?: string;
  publishable?: boolean;
  bio?: string;
  sources?: number;
  error?: string;
  result?: EnrichmentResult; // full output, for --dump quality review
}

// === Run a bounded-concurrency pool over COUNT jobs ===

if (!Number.isFinite(COUNT) || COUNT < 1) {
  console.error("--count must be a positive integer");
  process.exit(2);
}
if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1) {
  console.error("--concurrency must be a positive integer");
  process.exit(2);
}
if (!["real", "synthetic", "mix"].includes(NAMES_MODE)) {
  console.error(`--names must be real | synthetic | mix (got "${NAMES_MODE}")`);
  process.exit(2);
}

console.log(
  `[enrich-local-test] LOCAL free path (SearXNG + Ollama). count=${COUNT} concurrency=${CONCURRENCY} names=${NAMES_MODE}. No Anthropic, no Firestore.\n`
);

const seeds: Seed[] = Array.from({ length: COUNT }, (_, i) => buildSeed(i));
const outcomes: JobOutcome[] = new Array(COUNT);
let started = 0;
let finished = 0;
let inFlight = 0;
let peakInFlight = 0;
let nextIndex = 0;
const overallStart = Date.now();

function progress(): void {
  const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
  process.stdout.write(
    `\r[enrich-local-test] ${elapsed}s - started=${started}/${COUNT} done=${finished}/${COUNT} inFlight=${inFlight} peak=${peakInFlight}`.padEnd(100)
  );
}

async function runOne(i: number): Promise<void> {
  const seed = seeds[i];
  const input: EnrichmentInput = {
    uid: `elt-local-${i}`,
    displayName: seed.displayName,
    email: seed.email,
    linkedinHeadline: seed.linkedinHeadline,
    city: seed.city,
  };
  started++;
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  const t0 = Date.now();
  try {
    const r: EnrichmentResult = await runLocalEnrich(input);
    outcomes[i] = {
      name: seed.displayName,
      ok: true,
      ms: Date.now() - t0,
      confidence: r.confidence,
      publishable: passesGate(r.confidence),
      bio: r.bio,
      sources: r.sources.length,
      result: r,
    };
  } catch (e) {
    outcomes[i] = {
      name: seed.displayName,
      ok: false,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    inFlight--;
    finished++;
    progress();
  }
}

async function worker(): Promise<void> {
  while (true) {
    const i = nextIndex++;
    if (i >= COUNT) return;
    await runOne(i);
  }
}

progress();
const reporter = setInterval(progress, 1000);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, COUNT) }, () => worker()));
clearInterval(reporter);
process.stdout.write("\n\n");

// === Summary ===
const total = (Date.now() - overallStart) / 1000;
const ok = outcomes.filter((o) => o.ok);
const failed = outcomes.filter((o) => !o.ok);
const published = ok.filter((o) => o.publishable);
const conf: Record<string, number> = { high: 0, medium: 0, low: 0, none: 0 };
for (const o of ok) {
  const c = o.confidence ?? "none";
  conf[c] = (conf[c] ?? 0) + 1;
}
const times = outcomes.map((o) => o.ms / 1000);
const min = times.length ? Math.min(...times) : 0;
const max = times.length ? Math.max(...times) : 0;
const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
const sorted = [...times].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

console.log("=============== Local Enrichment Summary ===============");
console.log(`jobs:                       ${COUNT} (names=${NAMES_MODE}, concurrency=${CONCURRENCY})`);
console.log(`succeeded:                  ${ok.length}`);
console.log(`failed (threw):             ${failed.length}`);
console.log(`published (>= medium):      ${published.length}`);
console.log(`confidence spread:          high=${conf.high} medium=${conf.medium} low=${conf.low} none=${conf.none}`);
console.log(`peak concurrent in-flight:  ${peakInFlight}`);
console.log(`total wall time:            ${total.toFixed(1)}s`);
console.log(`per-job min/med/avg/max:    ${min.toFixed(1)}s / ${median.toFixed(1)}s / ${avg.toFixed(1)}s / ${max.toFixed(1)}s`);
console.log(`throughput:                 ${total > 0 ? ((COUNT * 60) / total).toFixed(1) : "0"} enrichments/min`);
console.log(`cost:                       $0 (local SearXNG + Ollama)`);

if (published.length) {
  console.log(`\nSample published profiles:`);
  for (const o of published.slice(0, 5)) {
    console.log(`  - ${o.name} [${o.confidence}, ${o.sources} sources]: ${(o.bio ?? "").slice(0, 90)}`);
  }
}
if (failed.length) {
  console.log(`\n${failed.length} job(s) threw. First few:`);
  for (const o of failed.slice(0, 6)) console.log(`  - ${o.name}: ${o.error?.slice(0, 160)}`);
  if (failed.length > 6) console.log(`  ...and ${failed.length - 6} more`);
}

if (DUMP) {
  console.log(`\n========== FULL ENRICHMENT DUMP (quality review) ==========`);
  for (const o of outcomes) {
    if (!o) continue;
    console.log(`\n### ${o.name}`);
    if (!o.ok) {
      console.log(`  (no result — ${o.error})`);
      continue;
    }
    const r = o.result!;
    console.log(`  confidence:     ${r.confidence}  (publishable=${passesGate(r.confidence)})`);
    console.log(`  bio:            ${r.bio || "(empty)"}`);
    console.log(`  topics:         ${r.topics.join(", ") || "(none)"}`);
    console.log(`  company:        ${r.company ?? "(none)"}`);
    console.log(`  recentActivity: ${r.recentActivity ?? "(none)"}`);
    console.log(`  matchSignals:   ${r.matchSignals ?? "(none)"}`);
    console.log(`  linkedinUrl:    ${r.linkedinUrl ?? "(none)"}`);
    console.log(`  rationale:      ${r.rationale ?? "(none)"}`);
    console.log(`  sources:`);
    for (const s of r.sources) console.log(`    - ${s}`);
  }
}

process.exit(0);
