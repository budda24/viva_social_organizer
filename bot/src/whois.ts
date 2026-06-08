import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const uids = ["linkedin:5Qig5Tc0x5","linkedin:toCprgDQrv","linkedin:XA-uvbgHBk","linkedin:4BmuULntUD","linkedin:9RNDPz0nFk","qa-tester-pk"];
for (const uid of uids) {
  const s = await db.doc(`users/${uid}`).get();
  if (!s.exists) { console.log(`${uid}  ->  (no doc)`); continue; }
  const d = s.data()!;
  console.log(`${uid}  ->  ${d.displayName ?? "(no name)"}  | status=${d.status} | tgChat=${d.telegramChatId ?? "-"}`);
}
process.exit(0);
