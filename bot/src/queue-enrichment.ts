/**
 * Manually queue an enrichment job for a user. Simulates what the Phase-2
 * Flutter LinkedIn sign-in flow will eventually do — writes the LinkedIn
 * seed data to the user doc and sets enrichment.status = "pending" so the
 * laptop brain's enrichment loop picks it up on the next tick.
 *
 * Usage:
 *   npx tsx src/queue-enrichment.ts --uid u-franek \
 *     --name "Franek Jablonski" \
 *     --email franek@online-tribes.com \
 *     --headline "Founder at Online Tribes · building Viva Tribe"
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uid = arg("uid");
const name = arg("name");
const email = arg("email");
const headline = arg("headline");
const linkedinId = arg("linkedinId");
const city = arg("city");

if (!uid) {
  console.error(
    "Usage: tsx src/queue-enrichment.ts --uid <uid> [--name '...'] [--email ...] [--headline '...'] [--linkedinId ...] [--city ...]"
  );
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const update: Record<string, unknown> = {
  "enrichment.status": "pending",
  "enrichment.attempts": 0,
  "enrichment.lastError": null,
  "enrichment.queuedAt": FieldValue.serverTimestamp(),
};

if (name) update.displayName = name;
if (email) update.email = email;
if (headline) update.linkedinHeadline = headline;
if (linkedinId) update.linkedinId = linkedinId;
if (city) update.city = city;

await db.doc(`users/${uid}`).set(update, { merge: true });

console.log(`[queue-enrichment] queued users/${uid} — enrichment.status=pending`);
console.log(`  seed data: name=${name ?? "(existing)"}, email=${email ?? "(existing)"}, headline=${headline ?? "(existing)"}`);
console.log(`The bot brain's enrichment loop will pick this up within ~5s (if running).`);
process.exit(0);
