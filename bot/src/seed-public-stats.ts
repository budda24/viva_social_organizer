/**
 * One-off: compute the current member count and seed public/stats so the
 * landing-page "N tribers" pill has a value before the first user write fires
 * the onUserWrite trigger. Idempotent — re-running just recomputes.
 * Run with: npx tsx src/seed-public-stats.ts
 */
import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as fs from "node:fs";

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

// Mirror the onUserWrite trigger: members = everyone not opted out.
const [total, optedOut] = await Promise.all([
  db.collection("users").count().get(),
  db.collection("users").where("status", "==", "opted_out").count().get(),
]);
const memberCount = Math.max(0, total.data().count - optedOut.data().count);
await db.doc("public/stats").set(
  { memberCount, updatedAt: FieldValue.serverTimestamp() },
  { merge: true },
);
console.log(`public/stats seeded: memberCount=${memberCount}`);
process.exit(0);
