/**
 * Laptop-hosted bot brain for VivaTech Social Organizer.
 *
 * Long-running process. Polls Firestore botInbox for pending messages and
 * processes them in parallel (up to MAX_CONCURRENT). Each message goes through
 * the Claude Agent SDK in-process and the reply is written to whatsappOutbox.
 *
 * Run locally: `npm run dev`
 * Run for the event: `bash run.sh` (caffeinate + auto-restart wrapper)
 */

import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import * as fs from "node:fs";
import { processMessage } from "./brain.js";
import { enrichmentTick } from "./enrich.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const ENRICH_POLL_INTERVAL_MS = Number(process.env.ENRICH_POLL_INTERVAL_MS ?? 5000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 5);
const MAX_ENRICH_CONCURRENT = Number(process.env.MAX_ENRICH_CONCURRENT ?? 2);
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 6);
const REQUEUE_BASE_MS = 1_000;
const REQUEUE_CAP_MS = 30_000;
const HOST_ID = process.env.BOT_HOST_ID ?? `laptop-${Math.random().toString(36).slice(2, 8)}`;

// Transient API conditions worth retrying rather than failing: rate limits (429)
// and overloads (529). Matched against the thrown error message so an overload
// burst becomes delay, not lost replies.
const TRANSIENT_RE = /\b(429|529)\b|rate limit|input tokens per minute|overloaded/i;

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}

const db = getFirestore();

const inFlight = new Set<string>();
const enrichInFlight = new Set<string>();

async function heartbeat(): Promise<void> {
  await db.doc(`system/botHeartbeat`).set(
    {
      hostId: HOST_ID,
      lastSeenAt: FieldValue.serverTimestamp(),
      inFlight: inFlight.size,
      maxConcurrent: MAX_CONCURRENT,
      version: process.env.npm_package_version ?? "0.1.0",
    },
    { merge: true }
  );
}

async function claimOne(): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const candidates = await db
    .collection("botInbox")
    .where("status", "==", "pending")
    .orderBy("receivedAt", "asc")
    .limit(MAX_CONCURRENT * 2)
    .get();
  if (candidates.empty) return null;

  for (const doc of candidates.docs) {
    if (inFlight.has(doc.id)) continue;
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      const d = snap.data();
      if (!d || d.status !== "pending") return false;
      // Honour backoff set by a previous transient failure — leave it pending
      // until its nextAttemptAt so we don't immediately re-slam a rate limit.
      const next = d.nextAttemptAt as Timestamp | undefined;
      if (next && next.toMillis() > Date.now()) return false;
      tx.update(doc.ref, {
        status: "processing",
        leasedBy: HOST_ID,
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + LEASE_MS),
        attempts: FieldValue.increment(1),
      });
      return true;
    });
    if (claimed) return doc;
  }
  return null;
}

async function processOne(doc: FirebaseFirestore.QueryDocumentSnapshot): Promise<void> {
  try {
    await processMessage({ db, inboxDoc: doc, hostId: HOST_ID });
    await doc.ref.update({
      status: "done",
      completedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[bot] processed ${doc.id} (uid=${doc.data().uid}, inFlight=${inFlight.size})`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const attempts = Number(doc.data().attempts ?? 0);
    if (TRANSIENT_RE.test(message) && attempts < MAX_ATTEMPTS) {
      // Overload/rate-limit → back off and requeue instead of dropping the
      // message. Exponential backoff with jitter; clears the lease so any
      // worker can pick it up once nextAttemptAt passes.
      const backoff =
        Math.min(REQUEUE_BASE_MS * 2 ** attempts, REQUEUE_CAP_MS) +
        Math.floor(Math.random() * REQUEUE_BASE_MS);
      console.warn(`[bot] requeue ${doc.id} (attempt ${attempts}, +${backoff}ms): ${message}`);
      await doc.ref.update({
        status: "pending",
        nextAttemptAt: Timestamp.fromMillis(Date.now() + backoff),
        leasedBy: FieldValue.delete(),
        leaseExpiresAt: FieldValue.delete(),
        lastError: message,
      });
    } else {
      console.error(`[bot] failed ${doc.id}: ${message}`);
      await doc.ref.update({
        status: "failed",
        lastError: message,
      });
    }
  } finally {
    inFlight.delete(doc.id);
  }
}

async function tick(): Promise<void> {
  // Claim as many as we have headroom for and fire them off in parallel.
  while (inFlight.size < MAX_CONCURRENT) {
    const doc = await claimOne();
    if (!doc) return;
    inFlight.add(doc.id);
    // Fire-and-forget — processOne removes from inFlight on completion.
    void processOne(doc);
  }
}

console.log(
  `[bot] starting — host=${HOST_ID}, poll=${POLL_INTERVAL_MS}ms, ` +
    `maxConcurrent=${MAX_CONCURRENT}, enrichPoll=${ENRICH_POLL_INTERVAL_MS}ms, ` +
    `maxEnrichConcurrent=${MAX_ENRICH_CONCURRENT}`
);

setInterval(() => {
  heartbeat().catch((e) => console.error("[bot] heartbeat failed:", e));
}, 15_000);

setInterval(() => {
  tick().catch((e) => console.error("[bot] tick failed:", e));
}, POLL_INTERVAL_MS);

setInterval(() => {
  enrichmentTick(db, HOST_ID, enrichInFlight, MAX_ENRICH_CONCURRENT).catch((e) =>
    console.error("[bot] enrichment tick failed:", e)
  );
}, ENRICH_POLL_INTERVAL_MS);

heartbeat().catch((e) => console.error("[bot] initial heartbeat failed:", e));
tick().catch((e) => console.error("[bot] initial tick failed:", e));
