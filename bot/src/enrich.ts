/**
 * Async profile-enrichment worker.
 *
 * Polls Firestore for users with `enrichment.status == "pending"`, then
 * spawns `claude -p` with the WebSearch/WebFetch tools enabled to research
 * the person from public sources (LinkedIn headline, company, talks, papers).
 * Synthesizes a JSON profile and saves it back to the user doc.
 *
 * No Tavily, no separate Anthropic API key — uses the same Claude CLI auth
 * the bot brain already relies on.
 *
 * Runs alongside the inbox poll loop in src/index.ts.
 */

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const ENRICH_MODEL = process.env.ENRICH_MODEL ?? "claude-sonnet-4-6";
const ENRICH_TIMEOUT_MS = Number(process.env.ENRICH_TIMEOUT_MS ?? 120_000);
const LEASE_MS = 180_000;

type EnrichmentStatus = "pending" | "running" | "complete" | "failed";

interface EnrichmentInput {
  uid: string;
  displayName?: string;
  email?: string;
  linkedinHeadline?: string;
  linkedinId?: string;
  city?: string;
}

type Confidence = "high" | "medium" | "low" | "none";

interface EnrichmentResult {
  bio: string;
  topics: string[];
  company?: string;
  recentActivity?: string;
  matchSignals?: string;
  // Provenance — required so we can audit "where did this fact come from?"
  // and so the UI can label verified vs. inferred fields.
  confidence: Confidence;
  linkedinUrl?: string;
  sources: string[];
  // The worker's own one-line explanation of why it thinks this is the right
  // person (or why it couldn't be sure). Stored for transparency, not shown
  // by default — useful when debugging a wrong-person attachment.
  rationale?: string;
}

/**
 * Build the prompt we hand to `claude -p`. The CLI auto-loads bot/CLAUDE.md
 * as its system prompt, so we override the persona via --append-system-prompt
 * with a focused enrichment-only persona for this one call.
 */
function buildEnrichPrompt(input: EnrichmentInput): { user: string; systemAppend: string } {
  const systemAppend = `
# Enrichment task — IGNORE the Tribu persona for this one call

You are NOT Tribu right now. You are a research tool building a professional
profile for matching at VivaTech Paris 2026.

## ABSOLUTE PRIORITY: do not attach context to the wrong person

The single most important failure mode here is **identity mismatch** — pulling
someone else's bio because their name is similar. A common name like "John
Smith" or "Sarah Lee" has hundreds of LinkedIn profiles. Attaching the wrong
person's bio to a real member is far worse than attaching nothing.

**Confidence rules — read carefully:**

- **high**: You found a public LinkedIn profile whose displayed name matches
  the verified name exactly AND at least one strong corroborating signal
  matches (e.g. a personal website / GitHub / company page / conference
  bio that names them in the same role). Email domain matching their
  company website also counts.
- **medium**: You found a likely LinkedIn profile match and one weaker signal
  (a talk, a paper, a podcast mention) that aligns with the name.
- **low**: You found mentions of someone with the name but no LinkedIn
  profile to anchor identity, OR you found multiple LinkedIn profiles for
  the name and can't pick between them.
- **none**: You couldn't find them at all.

**Strict gate**: if confidence is **low or none**, return empty strings /
empty arrays for bio, topics, company, recentActivity, matchSignals. Do NOT
guess. Do NOT pick the most plausible. The downstream code will store the
empty result and we'd rather have a sparse profile than a wrong one.

## Method

Use WebSearch and WebFetch. Start by searching for the verified name plus
a disambiguator (email domain if available, or "VivaTech" / "founder" /
known location). Find their LinkedIn URL first — that anchors identity.
Then triangulate with at least one other source before filling fields.

Track every URL you fetched in the \`sources\` array so the human reviewing
can verify.

## Output

Return ONLY a JSON object on the LAST line of your output. Schema:

{
  "confidence": "high" | "medium" | "low" | "none",
  "linkedinUrl": "the LinkedIn URL you identified, or empty",
  "sources": ["url1", "url2"],
  "rationale": "one line on why you're confident (or why you're not)",
  "bio": "one-line who they are professionally (max 140 chars), empty if confidence < medium",
  "topics": ["3 to 5", "interest", "tags"],
  "company": "current company if confidently known, else empty",
  "recentActivity": "one short line on visible recent work, else empty",
  "matchSignals": "one short line on who they would benefit from meeting at VivaTech, else empty"
}

The JSON object MUST be the last thing in your output, on its own line,
parseable as-is.
`.trim();

  const lines: string[] = [];
  lines.push(`Person to enrich:`);
  if (input.displayName) lines.push(`Name: ${input.displayName}`);
  if (input.email) lines.push(`Email: ${input.email}`);
  if (input.linkedinHeadline) lines.push(`LinkedIn headline: ${input.linkedinHeadline}`);
  if (input.linkedinId) lines.push(`LinkedIn member ID: ${input.linkedinId}`);
  if (input.city) lines.push(`City: ${input.city}`);
  lines.push(``);
  lines.push(`Research them on the public web and return the JSON profile.`);
  return { user: lines.join("\n"), systemAppend };
}

function runClaudeEnrich(input: EnrichmentInput): Promise<EnrichmentResult> {
  const { user, systemAppend } = buildEnrichPrompt(input);
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      user,
      "--model",
      ENRICH_MODEL,
      "--output-format",
      "text",
      "--append-system-prompt",
      systemAppend,
      "--allowedTools",
      "WebSearch,WebFetch",
    ];
    const child = spawn(CLAUDE_BIN, args, {
      cwd: BOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`enrich claude timed out after ${ENRICH_TIMEOUT_MS}ms`));
    }, ENRICH_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${CLAUDE_BIN}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`enrich claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const parsed = extractTrailingJson(stdout);
      if (!parsed) {
        reject(new Error(`enrich could not parse JSON from output: ${stdout.slice(-400)}`));
        return;
      }
      resolve(parsed);
    });
  });
}

function extractTrailingJson(output: string): EnrichmentResult | null {
  const trimmed = output.trim();
  // Find the last `{` and try parsing from there to the end.
  const lastBrace = trimmed.lastIndexOf("{");
  if (lastBrace === -1) return null;
  const candidate = trimmed.slice(lastBrace);
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed == null) return null;

    const rawConf = String(parsed.confidence ?? "").toLowerCase();
    const confidence: Confidence =
      rawConf === "high" || rawConf === "medium" || rawConf === "low"
        ? (rawConf as Confidence)
        : "none";

    const sources = Array.isArray(parsed.sources)
      ? (parsed.sources as unknown[])
          .map((s) => String(s).trim())
          .filter((s) => s.length > 0 && s.length < 500)
          .slice(0, 10)
      : [];

    const linkedinUrl = parsed.linkedinUrl
      ? String(parsed.linkedinUrl).slice(0, 300)
      : undefined;
    const rationale = parsed.rationale
      ? String(parsed.rationale).slice(0, 300)
      : undefined;

    return {
      bio: String(parsed.bio ?? "").slice(0, 200),
      topics: Array.isArray(parsed.topics)
        ? (parsed.topics as unknown[]).map(String).slice(0, 6)
        : [],
      company: parsed.company ? String(parsed.company).slice(0, 100) : undefined,
      recentActivity: parsed.recentActivity
        ? String(parsed.recentActivity).slice(0, 200)
        : undefined,
      matchSignals: parsed.matchSignals
        ? String(parsed.matchSignals).slice(0, 200)
        : undefined,
      confidence,
      linkedinUrl,
      sources,
      rationale,
    };
  } catch {
    return null;
  }
}

// Minimum confidence we trust enough to publish enriched content into the
// matchable profile. Below this we still record the audit trail (sources,
// rationale, confidence) but leave bio/topics/etc. empty so we don't risk
// showing wrong-person data in the directory or feeding it into match scoring.
const MIN_PUBLISHABLE_CONFIDENCE: Confidence = "medium";

function passesConfidenceGate(c: Confidence): boolean {
  if (MIN_PUBLISHABLE_CONFIDENCE === "high") return c === "high";
  if (MIN_PUBLISHABLE_CONFIDENCE === "medium") return c === "high" || c === "medium";
  return c !== "none";
}

async function claimOneEnrichmentJob(
  db: Firestore,
  hostId: string,
  inFlight: Set<string>
): Promise<QueryDocumentSnapshot | null> {
  const candidates = await db
    .collection("users")
    .where("enrichment.status", "==", "pending")
    .limit(3)
    .get();
  if (candidates.empty) return null;

  for (const doc of candidates.docs) {
    if (inFlight.has(doc.id)) continue;
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      const d = snap.data();
      if (!d || d.enrichment?.status !== "pending") return false;
      tx.update(doc.ref, {
        "enrichment.status": "running",
        "enrichment.leasedBy": hostId,
        "enrichment.leaseExpiresAt": Timestamp.fromMillis(Date.now() + LEASE_MS),
        "enrichment.attempts": FieldValue.increment(1),
        "enrichment.startedAt": FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (claimed) return doc;
  }
  return null;
}

async function processOneEnrichment(
  db: Firestore,
  doc: QueryDocumentSnapshot
): Promise<void> {
  const userData = doc.data();
  const input: EnrichmentInput = {
    uid: doc.id,
    displayName: userData.displayName,
    email: userData.email,
    linkedinHeadline: userData.linkedinHeadline,
    linkedinId: userData.linkedinId,
    city: userData.city,
  };

  try {
    const result = await runClaudeEnrich(input);
    const publishable = passesConfidenceGate(result.confidence);

    // Always persist provenance (confidence, sources, rationale, linkedinUrl)
    // even when we don't publish the content — it's the audit trail. The
    // matchable content fields (bio/topics/etc.) only flow through if the
    // worker's confidence cleared the gate; otherwise they stay empty and the
    // directory shows "Profile loading…" or "No bio yet" instead of risking
    // wrong-person data.
    await doc.ref.update({
      "enrichment.status": "complete" as EnrichmentStatus,
      "enrichment.confidence": result.confidence,
      "enrichment.linkedinUrl": result.linkedinUrl ?? null,
      "enrichment.sources": result.sources,
      "enrichment.rationale": result.rationale ?? null,
      "enrichment.publishable": publishable,
      "enrichment.bio": publishable ? result.bio : "",
      "enrichment.topics": publishable ? result.topics : [],
      "enrichment.company": publishable ? (result.company ?? null) : null,
      "enrichment.recentActivity": publishable ? (result.recentActivity ?? null) : null,
      "enrichment.matchSignals": publishable ? (result.matchSignals ?? null) : null,
      "enrichment.completedAt": FieldValue.serverTimestamp(),
      "enrichment.lastError": null,
    });
    if (publishable) {
      console.log(
        `[enrich] published uid=${doc.id} confidence=${result.confidence} bio="${result.bio.slice(0, 60)}…" sources=${result.sources.length}`
      );
    } else {
      console.log(
        `[enrich] withheld uid=${doc.id} confidence=${result.confidence} (below ${MIN_PUBLISHABLE_CONFIDENCE} threshold) rationale="${(result.rationale ?? "").slice(0, 100)}"`
      );
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[enrich] failed uid=${doc.id}: ${message}`);
    const attempts = (userData.enrichment?.attempts ?? 0) + 1;
    const final = attempts >= 3;
    await doc.ref.update({
      "enrichment.status": (final ? "failed" : "pending") as EnrichmentStatus,
      "enrichment.lastError": message,
    });
  }
}

/**
 * Single tick of the enrichment loop. Call repeatedly from a setInterval.
 * `inFlight` is shared mutable state so we don't double-pick the same uid.
 */
export async function enrichmentTick(
  db: Firestore,
  hostId: string,
  inFlight: Set<string>,
  maxConcurrent: number
): Promise<void> {
  while (inFlight.size < maxConcurrent) {
    const doc = await claimOneEnrichmentJob(db, hostId, inFlight);
    if (!doc) return;
    inFlight.add(doc.id);
    // Fire and forget — finally removes from inFlight.
    processOneEnrichment(db, doc).finally(() => inFlight.delete(doc.id));
  }
}
