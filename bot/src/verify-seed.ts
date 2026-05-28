/**
 * One-shot diagnostic: read back what the /in landing page would fetch and
 * print the docs the StreamBuilder would render. Use after seed-test-events.ts
 * to confirm the data + indexes line up before relying on a browser refresh.
 *
 *   npx tsx src/verify-seed.ts
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const snap = await db
  .collection("events")
  .where("status", "in", ["scheduled", "live"])
  .orderBy("startAt")
  .limit(12)
  .get();

console.log(`[verify] events query returned ${snap.size} docs`);
for (const d of snap.docs) {
  const data = d.data();
  const startAt = data.startAt?.toDate?.()?.toISOString() ?? "(no startAt)";
  console.log(
    `  - ${d.id} · ${data.title} · ${data.kind} · ${startAt} · host=${data.hostName}`
  );
}

const usersSnap = await db.collection("users").get();
console.log(`[verify] users collection: ${usersSnap.size} docs total`);
process.exit(0);
