/**
 * Local test injector — drop a fake message into Firestore botInbox, then watch
 * for the bot to mark it done and read back the reply from whatsappOutbox.
 *
 * Requires:
 *  - `npm run dev` already running in another terminal (the polling brain)
 *  - A user doc at users/{uid} with status="approved"
 *
 * Usage:
 *   npx tsx src/inject.ts --uid <uid> --phone <+1234567890> --body "help"
 *   npx tsx src/inject.ts --uid u-test --phone +33600000000 --body "free now"
 */

import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as fs from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const uid = arg("uid");
const phone = arg("phone");
const body = arg("body");
const timeoutSec = Number(arg("timeout") ?? 60);

if (!uid || !phone || !body) {
  console.error("Usage: tsx src/inject.ts --uid <uid> --phone <+E164> --body \"<text>\" [--timeout 60]");
  process.exit(2);
}

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}

const db = getFirestore();
const messageId = `inject-${Date.now()}`;

async function main() {
  console.log(`[inject] writing botInbox/${messageId}`);
  await db.doc(`botInbox/${messageId}`).set({
    messageId,
    phone,
    uid,
    body,
    receivedAt: FieldValue.serverTimestamp(),
    status: "pending",
    attempts: 0,
  });

  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < timeoutSec * 1000) {
    const snap = await db.doc(`botInbox/${messageId}`).get();
    const s = snap.data()?.status as string;
    if (s !== lastStatus) {
      console.log(`[inject] inbox status: ${s}`);
      lastStatus = s;
    }
    if (s === "done" || s === "failed") {
      if (s === "failed") {
        console.error(`[inject] FAILED: ${snap.data()?.lastError}`);
        process.exit(1);
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (lastStatus !== "done") {
    console.error(`[inject] timed out after ${timeoutSec}s (last status: ${lastStatus || "unset"})`);
    process.exit(1);
  }

  const out = await db
    .collection("whatsappOutbox")
    .where("recipientPhone", "==", phone)
    .where("type", "==", "bot_reply")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (out.empty) {
    console.error(`[inject] no outbox row found for ${phone}`);
    process.exit(1);
  }
  const reply = out.docs[0].data();
  console.log(`\n[inject] === REPLY ===`);
  console.log(reply.body);
  console.log(`[inject] ===  END  ===\n`);
  console.log(`[inject] outbox status: ${reply.status} · doc: whatsappOutbox/${out.docs[0].id}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("[inject] error:", e);
  process.exit(1);
});
