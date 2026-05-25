/**
 * One-shot: create (or update) an approved test user in Firestore so the
 * webhook + bot brain have something to resolve a phone number to.
 *
 * Usage:
 *   npx tsx src/seed-user.ts --uid u-test --phone +33600000000 --name "Test User"
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uid = arg("uid");
const phone = arg("phone");
const name = arg("name") ?? "Test User";

if (!uid || !phone) {
  console.error('Usage: tsx src/seed-user.ts --uid <uid> --phone <+E164> [--name "..."]');
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

await db.doc(`users/${uid}`).set(
  {
    displayName: name,
    whatsappPhoneE164: phone,
    status: "approved",
    consentWhatsappMessages: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  { merge: true }
);

console.log(`[seed] users/${uid} → status=approved, phone=${phone}`);
process.exit(0);
