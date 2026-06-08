import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const uid = process.argv[2] ?? "linkedin:7s6Cog1G8x";
const snap = await db.doc(`users/${uid}`).get();
if (!snap.exists) { console.log("USER DOC MISSING (signup not completed yet)"); process.exit(0); }
const d = snap.data()!;
console.log(JSON.stringify({ uid, source: d.source, sourceAt: d.sourceAt?.toDate?.()?.toISOString?.(), status: d.status, displayName: d.displayName, createdAt: d.createdAt?.toDate?.()?.toISOString?.() }, null, 2));
process.exit(0);
