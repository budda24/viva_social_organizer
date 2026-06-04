/**
 * Clear a user's CHAT (conversation history / brain state) without deleting the
 * user. Unlike delete-user.ts this is non-destructive: the account, RSVPs, and
 * events all survive — it only wipes `conversationStates/{uid}` so the next
 * message starts a fresh conversation (no remembered turns, no pending action,
 * no half-finished event-creation/edit wizard state).
 *
 * Users are looked up by email (the `email` field on `users/{uid}`).
 *
 * Usage:
 *   npx tsx src/clear-chat.ts --email a@x.com --email b@y.com
 *   npx tsx src/clear-chat.ts --email a@x.com --dry-run
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) out.push(process.argv[i + 1]);
  });
  return out.filter(Boolean);
}
const dryRun = process.argv.includes("--dry-run");
const emails = args("email").map((e) => e.trim().toLowerCase());

if (emails.length === 0) {
  console.error("Usage: tsx src/clear-chat.ts --email <addr> [--email <addr> ...] [--dry-run]");
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

console.log(`[clear-chat] project = ${process.env.GOOGLE_CLOUD_PROJECT ?? "(from ADC default)"}`);
console.log(`[clear-chat] emails  = ${emails.join(", ")}${dryRun ? "  (DRY RUN)" : ""}`);

for (const email of emails) {
  const snap = await db.collection("users").where("email", "==", email).get();
  if (snap.empty) {
    console.warn(`[clear-chat] ✗ no user found with email ${email}`);
    continue;
  }
  for (const userDoc of snap.docs) {
    const uid = userDoc.id;
    const name = (userDoc.data().displayName as string | undefined) ?? "(no name)";
    const convoRef = db.doc(`conversationStates/${uid}`);
    const existed = (await convoRef.get()).exists;
    if (dryRun) {
      console.log(`[clear-chat] would clear conversationStates/${uid} (${name}, ${email}) — ${existed ? "exists" : "no state"}`);
      continue;
    }
    await convoRef.delete().catch(() => {});
    console.log(`[clear-chat] ✓ cleared conversationStates/${uid} (${name}, ${email}) — ${existed ? "deleted" : "was empty"}`);
  }
}

process.exit(0);
