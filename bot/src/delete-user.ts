/**
 * One-shot cleanup: delete a user doc and any related bot state.
 * Use this when you accidentally seeded into the wrong Firebase project —
 * run it BEFORE switching gcloud/.env to the correct project.
 *
 * Usage:
 *   npx tsx src/delete-user.ts --uid u-test --phone +33600000000
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uid = arg("uid");
const phone = arg("phone");

if (!uid) {
  console.error("Usage: tsx src/delete-user.ts --uid <uid> [--phone <+E164>]");
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

console.log(`[cleanup] target project = ${process.env.GOOGLE_CLOUD_PROJECT ?? "(from ADC default)"}`);

await db.doc(`users/${uid}`).delete();
console.log(`[cleanup] deleted users/${uid}`);

if (phone) {
  await db.doc(`conversationStates/${phone}`).delete().catch(() => {});
  console.log(`[cleanup] deleted conversationStates/${phone} (if existed)`);

  const inbox = await db.collection("botInbox").where("phone", "==", phone).get();
  for (const d of inbox.docs) await d.ref.delete();
  console.log(`[cleanup] deleted ${inbox.size} botInbox row(s) for ${phone}`);

  const outbox = await db.collection("whatsappOutbox").where("recipientPhone", "==", phone).get();
  for (const d of outbox.docs) await d.ref.delete();
  console.log(`[cleanup] deleted ${outbox.size} whatsappOutbox row(s) for ${phone}`);
}

process.exit(0);
