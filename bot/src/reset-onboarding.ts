/**
 * Reset a user's onboarding to "pending" and clean up the stale literal
 * `onboarding.step` root field that the old dot-notation bug created.
 *
 * Usage (pick one identifier):
 *   npx tsx src/reset-onboarding.ts --uid u-test
 *   npx tsx src/reset-onboarding.ts --chatId 987654321
 *   npx tsx src/reset-onboarding.ts --phone +33600000000
 */

import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import {
  getFirestore,
  FieldPath,
  FieldValue,
} from "firebase-admin/firestore";
import * as fs from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uidArg = arg("uid");
const chatIdArg = arg("chatId");
const phoneArg = arg("phone");

if (!uidArg && !chatIdArg && !phoneArg) {
  console.error(
    "Pass one of: --uid <uid> | --chatId <number> | --phone <+E164>"
  );
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
  const field = chatIdArg ? "telegramChatId" : "whatsappPhoneE164";
  const value = chatIdArg ? Number(chatIdArg) : phoneArg!;
  const snap = await db.collection("users").where(field, "==", value).limit(1).get();
  if (snap.empty) {
    throw new Error(`No user found with ${field} = ${value}`);
  }
  return snap.docs[0].id;
}

async function main() {
  const uid = await findUid();
  const ref = db.doc(`users/${uid}`);
  const before = (await ref.get()).data();
  console.log(`[reset] users/${uid} BEFORE:`, JSON.stringify(before, null, 2));

  // 1. Nuke the stale literal root field created by the dot-notation bug.
  //    new FieldPath(<string with dots>) is treated as ONE literal segment.
  try {
    await ref.update(
      new FieldPath("onboarding.step"),
      FieldValue.delete()
    );
    console.log(`[reset] deleted stale literal field 'onboarding.step'`);
  } catch (e) {
    // Field may not exist on this doc — that's fine.
    console.log(`[reset] no stale literal field to delete (ok)`);
  }
  try {
    await ref.update(
      new FieldPath("onboarding.completedAt"),
      FieldValue.delete()
    );
  } catch {
    /* noop */
  }

  // 2. Replace the nested onboarding object — clean state, no garbage.
  await ref.update({
    onboarding: { step: "pending" },
    goal: FieldValue.delete(),
    energy: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const after = (await ref.get()).data();
  console.log(`[reset] users/${uid} AFTER:`, JSON.stringify(after, null, 2));
  console.log(
    `[reset] ✓ Send any message to the bot now — onboarding restarts cleanly.`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[reset]", e);
  process.exit(1);
});
