/**
 * Clear a user's conversation history (the rolling `turns` the bot replays as
 * context). Useful when stale turns anchor the model to a prior answer — e.g.
 * repeated test queries during QA. Leaves onboarding/profile/bindings intact.
 *
 * Usage:
 *   npx tsx src/clear-history.ts --uid linkedin:7s6Cog1G8x
 *   npx tsx src/clear-history.ts --chatId 987654321
 */

import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uidArg = arg("uid");
const chatIdArg = arg("chatId");
if (!uidArg && !chatIdArg) {
  console.error("Pass one of: --uid <uid> | --chatId <number>");
  process.exit(2);
}

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

async function findUid(): Promise<string> {
  if (uidArg) return uidArg;
  const snap = await db
    .collection("users")
    .where("telegramChatId", "==", Number(chatIdArg))
    .limit(1)
    .get();
  if (snap.empty) throw new Error(`No user with telegramChatId = ${chatIdArg}`);
  return snap.docs[0].id;
}

async function main() {
  const uid = await findUid();
  await db.doc(`conversationStates/${uid}`).set({ turns: [] }, { merge: true });
  console.log(`Cleared conversation turns for ${uid}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
