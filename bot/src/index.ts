/**
 * Laptop-hosted bot brain for VivaTech Social Organizer.
 *
 * Long-running process. Polls Firestore botInbox for pending messages,
 * processes each via Anthropic Claude with Firestore tool-calls, and writes
 * replies to whatsappOutbox.
 *
 * Run locally: `npm run dev`
 * Run for the event: `bash run.sh` (caffeinate + auto-restart wrapper)
 */

import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs";
import { processMessage } from "./brain.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const LEASE_MS = 60_000;
const HOST_ID = process.env.BOT_HOST_ID ?? `laptop-${Math.random().toString(36).slice(2, 8)}`;

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}

const db = getFirestore();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let processing = false;
let lastHeartbeatAt = 0;

async function heartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatAt < 15_000) return;
  lastHeartbeatAt = now;
  await db.doc(`system/botHeartbeat`).set(
    {
      hostId: HOST_ID,
      lastSeenAt: FieldValue.serverTimestamp(),
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
    .limit(5)
    .get();
  if (candidates.empty) return null;

  for (const doc of candidates.docs) {
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      const d = snap.data();
      if (!d || d.status !== "pending") return false;
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

async function tick() {
  if (processing) return;
  processing = true;
  try {
    await heartbeat();
    const doc = await claimOne();
    if (!doc) return;

    try {
      await processMessage({ db, anthropic, inboxDoc: doc, hostId: HOST_ID });
      await doc.ref.update({
        status: "done",
        completedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[bot] processed ${doc.id} (uid=${doc.data().uid})`);
    } catch (e: any) {
      console.error(`[bot] failed ${doc.id}:`, e?.message ?? e);
      await doc.ref.update({
        status: "failed",
        lastError: String(e?.message ?? e),
      });
    }
  } finally {
    processing = false;
  }
}

console.log(`[bot] starting — host=${HOST_ID}, poll=${POLL_INTERVAL_MS}ms`);
setInterval(tick, POLL_INTERVAL_MS);
tick().catch((e) => console.error("[bot] initial tick failed:", e));
