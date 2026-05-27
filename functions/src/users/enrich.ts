/**
 * Async profile enrichment — Firestore-triggered Cloud Function.
 *
 * Runs whenever a users/{uid} doc is written with enrichment.status="pending"
 * (e.g. set by linkedinSignIn on first sign-in). Does the work entirely
 * server-side: no laptop brain required, no claude CLI needed. Uses the
 * Anthropic SDK with the built-in web_search tool to find the person on
 * public sources, applies the same confidence gate as the laptop worker,
 * and writes back enrichment fields.
 *
 * Replaces the old bot/src/enrich.ts laptop polling loop. The laptop loop
 * is harmless if still running — its transactional claim will lose to this
 * function's claim — but production deployments should rely on this.
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Model + web-search budget — Sonnet 4.6 supports web_search and gives high-
// quality short bios. max_uses caps tool calls so a stubborn enrichment
// can't burn unbounded budget on one user.
const ENRICH_MODEL = "claude-sonnet-4-6";
const MAX_WEB_SEARCHES = 6;

// Function-level timeout (9 min). The web_search tool calls can add up;
// Cloud Functions v2 max is 540s. Most enrichments finish in 30-90s.
const FN_TIMEOUT_SEC = 540;

// Lease used to prevent stuck "running" entries from blocking re-trigger.
// If a function dies mid-run, the doc stays in "running"; this lease lets
// a future write-trigger reclaim it.
const LEASE_MS = 5 * 60 * 1000;

type Confidence = "high" | "medium" | "low" | "none";

interface EnrichmentResult {
  bio: string;
  topics: string[];
  company?: string;
  recentActivity?: string;
  matchSignals?: string;
  confidence: Confidence;
  linkedinUrl?: string;
  sources: string[];
  rationale?: string;
}

const MIN_PUBLISHABLE_CONFIDENCE: Confidence = "medium";

function passesConfidenceGate(c: Confidence): boolean {
  if (MIN_PUBLISHABLE_CONFIDENCE === "high") return c === "high";
  if (MIN_PUBLISHABLE_CONFIDENCE === "medium")
    return c === "high" || c === "medium";
  return c !== "none";
}

export const enrichUser = onDocumentWritten(
  {
    document: "users/{uid}",
    secrets: [ANTHROPIC_API_KEY],
    region: "europe-central2",
    timeoutSeconds: FN_TIMEOUT_SEC,
    memory: "512MiB",
    // Only one concurrent enrichment per uid — Firestore trigger fans out
    // by document, so each uid lands on its own instance.
    concurrency: 1,
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // doc deleted

    const beforeStatus = before?.enrichment?.status as string | undefined;
    const afterStatus = after.enrichment?.status as string | undefined;

    // Only act on a fresh transition INTO "pending". Ignores other writes
    // so we don't loop on our own status updates.
    if (afterStatus !== "pending") return;
    if (beforeStatus === "pending") return;

    const uid = event.params.uid as string;
    const db = getFirestore();
    const userRef = db.doc(`users/${uid}`);

    // Claim the job via transaction — guarantees a single worker even if
    // both this trigger and the legacy laptop poll fire at the same time.
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const d = snap.data();
      if (d?.enrichment?.status !== "pending") return false;
      tx.update(userRef, {
        "enrichment.status": "running",
        "enrichment.startedAt": FieldValue.serverTimestamp(),
        "enrichment.attempts": FieldValue.increment(1),
        "enrichment.leaseExpiresAt": Timestamp.fromMillis(
          Date.now() + LEASE_MS
        ),
        "enrichment.workerKind": "cloud-fn",
      });
      return true;
    });
    if (!claimed) {
      console.log(`[enrichUser] uid=${uid} skipped — not pending after claim`);
      return;
    }

    try {
      const result = await runEnrichment({
        uid,
        displayName: after.displayName as string | undefined,
        email: after.email as string | undefined,
        linkedinId: (after.linkedinId ?? after.linkedinSub) as
          | string
          | undefined,
        apiKey: ANTHROPIC_API_KEY.value(),
      });

      const publishable = passesConfidenceGate(result.confidence);
      await userRef.update({
        "enrichment.status": "complete",
        "enrichment.confidence": result.confidence,
        "enrichment.linkedinUrl": result.linkedinUrl ?? null,
        "enrichment.sources": result.sources,
        "enrichment.rationale": result.rationale ?? null,
        "enrichment.publishable": publishable,
        "enrichment.bio": publishable ? result.bio : "",
        "enrichment.topics": publishable ? result.topics : [],
        "enrichment.company": publishable ? (result.company ?? null) : null,
        "enrichment.recentActivity": publishable
          ? (result.recentActivity ?? null)
          : null,
        "enrichment.matchSignals": publishable
          ? (result.matchSignals ?? null)
          : null,
        "enrichment.completedAt": FieldValue.serverTimestamp(),
        "enrichment.lastError": null,
      });

      console.log(
        `[enrichUser] uid=${uid} ${publishable ? "published" : "withheld"} ` +
          `confidence=${result.confidence} sources=${result.sources.length}`
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[enrichUser] uid=${uid} failed: ${message}`);
      const attempts = ((after.enrichment?.attempts as number | undefined) ?? 0) + 1;
      const final = attempts >= 3;
      await userRef.update({
        "enrichment.status": final ? "failed" : "pending",
        "enrichment.lastError": message.slice(0, 500),
      });
    }
  }
);

interface EnrichInput {
  uid: string;
  displayName?: string;
  email?: string;
  linkedinId?: string;
  apiKey: string;
}

async function runEnrichment(input: EnrichInput): Promise<EnrichmentResult> {
  const client = new Anthropic({ apiKey: input.apiKey });

  const system =
    `You are a research tool building a short professional profile for VivaTech ` +
    `Paris 2026 attendee matching.

ABSOLUTE PRIORITY: do not attach context to the wrong person. A common name like
"John Smith" has hundreds of LinkedIn profiles. Attaching the wrong person's bio
is far worse than attaching nothing.

Confidence rules:
- high: You found a public LinkedIn profile whose displayed name EXACTLY matches
  the verified name AND at least one strong corroborating signal (personal site,
  GitHub, company page, talk bio that names them in same role). Email domain
  matching company website counts.
- medium: Likely LinkedIn match + one weaker signal (talk, paper, podcast).
- low: Mentions found but no LinkedIn anchor, OR multiple LinkedIn profiles
  for the name and can't pick.
- none: Couldn't find them.

If confidence is low/none, return empty strings/arrays for bio/topics/company/
recentActivity/matchSignals. Do NOT guess. Do NOT pick the most plausible.

Method: WebSearch first to find LinkedIn URL by name + disambiguator (email
domain if present, or "VivaTech" / known city). Then triangulate with one
more source before filling fields.

OUTPUT: return ONLY a JSON object on the LAST line, schema:
{
  "confidence": "high"|"medium"|"low"|"none",
  "linkedinUrl": "...",
  "sources": ["url1","url2"],
  "rationale": "one line — why confident or why not",
  "bio": "one-line who they are professionally, max 140 chars, empty if confidence < medium",
  "topics": ["3 to 5", "interest", "tags"],
  "company": "current company if confident",
  "recentActivity": "one short line on visible recent work",
  "matchSignals": "one short line on who they should meet at VivaTech"
}
The JSON MUST be the last thing in your reply, on its own line, parseable as-is.`;

  const userParts: string[] = ["Person to enrich:"];
  if (input.displayName) userParts.push(`Name: ${input.displayName}`);
  if (input.email) userParts.push(`Email: ${input.email}`);
  if (input.linkedinId)
    userParts.push(`LinkedIn member ID: ${input.linkedinId}`);
  userParts.push("");
  userParts.push("Research them and return the JSON profile.");

  const response = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 4096,
    system,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: MAX_WEB_SEARCHES,
      } as unknown as Anthropic.Tool,
    ],
    messages: [{ role: "user", content: userParts.join("\n") }],
  });

  // Collect all text blocks from the final assistant turn.
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");

  const parsed = extractTrailingJson(text);
  if (!parsed) {
    throw new Error(
      `Could not parse JSON from model output: ${text.slice(-400)}`
    );
  }
  return parsed;
}

function extractTrailingJson(output: string): EnrichmentResult | null {
  const trimmed = output.trim();
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

    return {
      bio: String(parsed.bio ?? "").slice(0, 200),
      topics: Array.isArray(parsed.topics)
        ? (parsed.topics as unknown[]).map(String).slice(0, 6)
        : [],
      company: parsed.company
        ? String(parsed.company).slice(0, 100)
        : undefined,
      recentActivity: parsed.recentActivity
        ? String(parsed.recentActivity).slice(0, 200)
        : undefined,
      matchSignals: parsed.matchSignals
        ? String(parsed.matchSignals).slice(0, 200)
        : undefined,
      confidence,
      linkedinUrl: parsed.linkedinUrl
        ? String(parsed.linkedinUrl).slice(0, 300)
        : undefined,
      sources,
      rationale: parsed.rationale
        ? String(parsed.rationale).slice(0, 300)
        : undefined,
    };
  } catch {
    return null;
  }
}
