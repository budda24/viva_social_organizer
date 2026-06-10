/**
 * One-off: read system/botHeartbeat and report how the webhook's offline check
 * would evaluate it right now. Mirrors isBrainOffline() in the telegram webhook
 * (BRAIN_OFFLINE_MS = 90s). Run with: npx tsx src/check-heartbeat.ts
 */
import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as fs from "node:fs";

const BRAIN_OFFLINE_MS = 90_000;

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

const snap = await db.doc("system/botHeartbeat").get();
const data = snap.data();
const last = data?.lastSeenAt as Timestamp | undefined;
if (!last) {
  console.log("no heartbeat doc / lastSeenAt → webhook would treat brain as OFFLINE");
} else {
  const ageMs = Date.now() - last.toMillis();
  const offline = ageMs > BRAIN_OFFLINE_MS;
  console.log(
    `host=${data?.hostId} lastSeen=${Math.round(ageMs / 1000)}s ago ` +
      `(threshold ${BRAIN_OFFLINE_MS / 1000}s) → webhook verdict: ${offline ? "OFFLINE (fallback)" : "online (normal)"}`
  );
}
process.exit(0);
