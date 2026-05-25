/**
 * One-shot: bind a Telegram chat to an existing approved user, so messages
 * from that chat resolve via the Telegram webhook without needing the
 * /start <inviteCode> binding flow. Useful for manual testing.
 *
 * Usage:
 *   npx tsx src/seed-telegram.ts --uid u-test --chatId 987654321 [--username dmazurkiewicz]
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uid = arg("uid");
const chatIdRaw = arg("chatId");
const username = arg("username");

if (!uid || !chatIdRaw) {
  console.error('Usage: tsx src/seed-telegram.ts --uid <uid> --chatId <number> [--username "..."]');
  process.exit(2);
}

const chatId = Number(chatIdRaw);
if (!Number.isFinite(chatId)) {
  console.error(`--chatId must be a number, got ${chatIdRaw}`);
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

await db.doc(`users/${uid}`).set(
  {
    telegramChatId: chatId,
    telegramUsername: username ?? null,
    status: "approved",
    consentWhatsappMessages: true,
    updatedAt: FieldValue.serverTimestamp(),
  },
  { merge: true }
);

console.log(`[seed] users/${uid} → telegramChatId=${chatId}, username=${username ?? "(none)"}, status=approved`);
process.exit(0);
