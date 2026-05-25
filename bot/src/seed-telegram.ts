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
const onboardingArg = arg("onboarding") ?? "pending"; // pending | complete | reset

if (!uid || !chatIdRaw) {
  console.error(
    'Usage: tsx src/seed-telegram.ts --uid <uid> --chatId <number> [--username "..."] [--onboarding pending|complete|reset]'
  );
  process.exit(2);
}

const chatId = Number(chatIdRaw);
if (!Number.isFinite(chatId)) {
  console.error(`--chatId must be a number, got ${chatIdRaw}`);
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const update: Record<string, unknown> = {
  telegramChatId: chatId,
  telegramUsername: username ?? null,
  status: "approved",
  consentWhatsappMessages: true,
  updatedAt: FieldValue.serverTimestamp(),
};

// onboarding flag:
//   pending  → next message triggers the 3-question flow
//   complete → skip onboarding entirely (already done elsewhere)
//   reset    → also wipe bio/topics/lookingFor so a full re-onboard happens
if (onboardingArg === "complete") {
  update.onboarding = { step: "complete" };
} else if (onboardingArg === "reset") {
  update.onboarding = { step: "pending" };
  update.bio = FieldValue.delete();
  update.topics = FieldValue.delete();
  update.lookingFor = FieldValue.delete();
} else {
  update.onboarding = { step: "pending" };
}

await db.doc(`users/${uid}`).set(update, { merge: true });

console.log(
  `[seed] users/${uid} → telegramChatId=${chatId}, username=${
    username ?? "(none)"
  }, status=approved, onboarding=${onboardingArg}`
);
process.exit(0);
