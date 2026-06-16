/**
 * DESTRUCTIVE: wipe the entire production database to a clean slate for launch.
 *
 * Backs up users + events to /tmp first, then deletes EVERY doc in the data and
 * operational collections, then deletes EVERY Firebase Auth account. The Auth
 * step uses the Identity Toolkit REST API directly (not firebase-admin) because
 * the Admin SDK 403s under local ADC — see project_delete_user_auth_gotcha.
 *
 * Requires an explicit guard flag so it can never run by accident:
 *   npx tsx src/purge-prod.ts --yes-wipe-production
 */

import "./env.js";
import * as fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!process.argv.includes("--yes-wipe-production")) {
  console.error("Refusing to run without --yes-wipe-production");
  process.exit(2);
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) {
  console.error("GOOGLE_CLOUD_PROJECT is unset; aborting.");
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

console.log(`[purge] project = ${project}\n`);

// --- 1. Backup users + events to /tmp ------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup: Record<string, unknown[]> = {};
for (const c of ["users", "events"]) {
  const snap = await db.collection(c).get();
  backup[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
const backupPath = `/tmp/viva-prod-backup-${stamp}.json`;
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`[purge] backup written: ${backupPath} (users=${backup.users.length}, events=${backup.events.length})\n`);

// --- 2. Delete every doc in each collection ------------------------------
async function wipeCollection(name: string): Promise<number> {
  let total = 0;
  // Page through so huge collections (whatsappOutbox ~3.6k) don't OOM.
  while (true) {
    const snap = await db.collection(name).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    total += snap.size;
    process.stdout.write(`\r[purge] ${name}: ${total} deleted`);
  }
  console.log(`\r[purge] ${name}: ${total} deleted        `);
  return total;
}

const collections = [
  "users",
  "events",
  "botInbox",
  "whatsappOutbox",
  "conversationStates",
  "inviteCodes",
  "introRequests",
  "rsvps",
];
for (const c of collections) await wipeCollection(c);

// --- 3. Delete every Firebase Auth account via REST ----------------------
console.log(`\n[purge] deleting Firebase Auth accounts via Identity Toolkit REST...`);
// Mint an ADC access token in-process (google-auth-library, not the gcloud CLI:
// shelling out to gcloud fails under tsx because it isn't on the spawned PATH).
// We set X-Goog-User-Project explicitly on every call, which is what makes the
// Identity Toolkit admin endpoints work under local ADC — see
// project_delete_user_auth_gotcha. Getting the token via gcloud vs the library
// is irrelevant; the explicit header is what fixes the quota-project 403.
let token: string | null | undefined;
try {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  token = await (await auth.getClient()).getAccessToken().then((t) => t.token);
} catch (e) {
  console.error("[purge] could not mint an ADC access token; skipping Auth deletion.", e);
}
if (!token) {
  console.error("[purge] no token; finish Auth deletion in Firebase Console → Authentication.");
  process.exit(1);
}

const base = `https://identitytoolkit.googleapis.com/v1/projects/${project}`;
const headers = {
  Authorization: `Bearer ${token}`,
  "X-Goog-User-Project": project,
  "Content-Type": "application/json",
};

// Enumerate all accounts (admin query, up to 500 per page).
let nextToken: string | undefined;
const localIds: string[] = [];
do {
  const body: Record<string, unknown> = { tenantId: undefined };
  if (nextToken) body.nextPageToken = nextToken;
  const res = await fetch(`${base}/accounts:query`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[purge] accounts:query failed (${res.status}): ${await res.text()}`);
    break;
  }
  const json = (await res.json()) as { userInfo?: { localId: string }[]; nextPageToken?: string };
  for (const u of json.userInfo ?? []) localIds.push(u.localId);
  nextToken = json.nextPageToken;
} while (nextToken);

console.log(`[purge] found ${localIds.length} auth account(s)`);
let deleted = 0;
for (const localId of localIds) {
  const res = await fetch(`${base}/accounts:delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ localId }),
  });
  if (res.ok) {
    deleted++;
  } else {
    console.warn(`[purge] failed to delete auth ${localId} (${res.status}): ${await res.text()}`);
  }
}
console.log(`[purge] deleted ${deleted}/${localIds.length} auth account(s)`);

console.log(`\n[purge] done. Backup at ${backupPath}`);
process.exit(0);
