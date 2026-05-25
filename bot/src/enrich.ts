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

interface EnrichmentResult {
  bio: string;
  topics: string[];
  company?: string;
  recentActivity?: string;
  matchSignals?: string;
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

Search the public web for the person described below. Use WebSearch and
WebFetch as needed. Combine the LinkedIn headline (if given) with public
mentions: company website, blog posts, podcasts, conference talks, GitHub,
papers. Do NOT fabricate. If you can't find something, leave the field
empty rather than guessing.

Return ONLY a JSON object on the LAST line of your output, with this shape:

{
  "bio": "one-line who they are professionally (max 140 chars)",
  "topics": ["3 to 5", "interest", "tags"],
  "company": "current company if confidently known, else empty",
  "recentActivity": "one short line on visible recent work (talk, paper, launch, etc.), else empty",
  "matchSignals": "one short line on what kinds of people would be high-value for them to meet at VivaTech, else empty"
}

Any preamble or explanation is fine, but the JSON object MUST be the last
thing in your output, on its own line, parseable as-is.
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
    const parsed = JSON.parse(candidate);
    if (typeof parsed !== "object" || parsed == null) return null;
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
    };
  } catch {
    return null;
  }
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
    await doc.ref.update({
      "enrichment.status": "complete" as EnrichmentStatus,
      "enrichment.bio": result.bio,
      "enrichment.topics": result.topics,
      "enrichment.company": result.company ?? null,
      "enrichment.recentActivity": result.recentActivity ?? null,
      "enrichment.matchSignals": result.matchSignals ?? null,
      "enrichment.completedAt": FieldValue.serverTimestamp(),
      "enrichment.lastError": null,
    });
    console.log(
      `[enrich] complete uid=${doc.id} bio="${result.bio.slice(0, 60)}…" topics=${result.topics.join(",")}`
    );
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
