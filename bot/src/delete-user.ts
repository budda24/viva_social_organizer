/**
 * One-shot cleanup: delete a user and ALL related bot state.
 *
 * Use this to remove a (usually test) user cleanly. The important part is that
 * it does NOT leave a half-deleted user behind: it also deletes the Firebase
 * Auth account and the personal Telegram binding code(s). Without that, a
 * deleted user whose browser still holds a live auth session lands on the
 * welcome screen, can't read their (now-missing) user doc, falls back to the
 * placeholder invite code, and the Telegram bot rejects the deep link with
 * "that invite link looks invalid" — the exact loop this script prevents.
 *
 * What it removes:
 *   - auth user {uid}                          (unless --keep-auth)
 *   - users/{uid}
 *   - inviteCodes/* where usedBy array-contains {uid}   (telegram binding codes)
 *   - conversationStates/{uid}                 (telegram brain state)
 *   - botInbox/* where uid == {uid}
 *   - whatsappOutbox/* where recipientUid == {uid}
 *   - (with --phone) the twilio-keyed conversationStates / botInbox / outbox rows
 *
 * Usage:
 *   npx tsx src/delete-user.ts --uid linkedin:abc123
 *   npx tsx src/delete-user.ts --uid u-test --phone +33600000000
 *   npx tsx src/delete-user.ts --uid u-test --keep-auth   # leave login intact
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const uid = arg("uid");
const phone = arg("phone");
const keepAuth = flag("keep-auth");

if (!uid) {
  console.error(
    "Usage: tsx src/delete-user.ts --uid <uid> [--phone <+E164>] [--keep-auth]"
  );
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

console.log(`[cleanup] target project = ${process.env.GOOGLE_CLOUD_PROJECT ?? "(from ADC default)"}`);

// Delete every doc returned by a query, in batches.
async function deleteWhere(
  collection: string,
  field: string,
  op: FirebaseFirestore.WhereFilterOp,
  value: unknown,
  label: string
): Promise<void> {
  const snap = await db.collection(collection).where(field, op, value as never).get();
  for (const d of snap.docs) await d.ref.delete();
  console.log(`[cleanup] deleted ${snap.size} ${label}`);
}

await db.doc(`users/${uid}`).delete();
console.log(`[cleanup] deleted users/${uid}`);

// Personal Telegram binding code(s) — pre-redeemed to this uid. Leaving these
// behind orphans them; deleting forces a fresh code on next sign-in.
await deleteWhere("inviteCodes", "usedBy", "array-contains", uid, `inviteCodes for ${uid}`);

// Telegram brain conversation state is keyed by uid (see brain.ts).
await db.doc(`conversationStates/${uid}`).delete().catch(() => {});
console.log(`[cleanup] deleted conversationStates/${uid} (if existed)`);

// Pending/processed bot traffic addressed to this uid.
await deleteWhere("botInbox", "uid", "==", uid, `botInbox row(s) for ${uid}`);
await deleteWhere("whatsappOutbox", "recipientUid", "==", uid, `whatsappOutbox row(s) for ${uid}`);

// Delete the Auth account so a stale browser session can't keep the user in a
// signed-in-but-doc-missing limbo. --keep-auth opts out (e.g. you only want to
// force re-onboarding while preserving the login).
if (keepAuth) {
  console.log(`[cleanup] --keep-auth set; leaving auth user ${uid} intact`);
} else {
  try {
    await getAuth().revokeRefreshTokens(uid);
    await getAuth().deleteUser(uid);
    console.log(`[cleanup] deleted auth user ${uid}`);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "auth/user-not-found") {
      console.log(`[cleanup] auth user ${uid} not found (already gone)`);
    } else {
      console.warn(`[cleanup] could not delete auth user ${uid}:`, e);
    }
  }
}

if (phone) {
  await db.doc(`conversationStates/${phone}`).delete().catch(() => {});
  console.log(`[cleanup] deleted conversationStates/${phone} (if existed)`);

  await deleteWhere("botInbox", "phone", "==", phone, `botInbox row(s) for ${phone}`);
  await deleteWhere(
    "whatsappOutbox",
    "recipientPhone",
    "==",
    phone,
    `whatsappOutbox row(s) for ${phone}`
  );
}

process.exit(0);
