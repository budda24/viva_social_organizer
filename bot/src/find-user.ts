/**
 * Read-only lookup: list users, optionally filtered by a phone prefix.
 *
 * Usage:
 *   npx tsx src/find-user.ts            # list all
 *   npx tsx src/find-user.ts +92        # only phones starting with +92
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const prefix = process.argv[2];

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const snap = await db.collection("users").get();
const rows: any[] = [];
for (const d of snap.docs) {
  const u = d.data() as Record<string, unknown>;
  const phone = (u.whatsappPhoneE164 as string) ?? "";
  if (prefix && !phone.startsWith(prefix)) continue;
  rows.push({
    uid: d.id,
    name: u.displayName ?? "",
    phone,
    telegramChatId: u.telegramChatId ?? "",
    status: u.status ?? "",
  });
}

console.log(`[find] ${rows.length} user(s)${prefix ? ` matching phone ${prefix}*` : ""}:`);
for (const r of rows) console.log(JSON.stringify(r));
process.exit(0);
