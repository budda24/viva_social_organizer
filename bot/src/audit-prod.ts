/**
 * Read-only production audit: enumerate users + events and classify each as
 * real vs test/demo/load-test, so we know exactly what a pre-launch cleanup
 * would touch. Touches nothing.
 *
 *   npx tsx src/audit-prod.ts
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

console.log(`[audit] project = ${process.env.GOOGLE_CLOUD_PROJECT ?? "(from ADC default)"}\n`);

const usersSnap = await db.collection("users").get();
console.log(`=== users: ${usersSnap.size} total ===`);

const buckets: Record<string, string[]> = { real: [], test: [], demo: [], loadtest: [], seedUid: [] };

for (const d of usersSnap.docs) {
  const u = d.data();
  const reachable = u.telegramChatId != null || u.whatsappPhoneE164 != null;
  const tags: string[] = [];
  if (u.isTestData === true) tags.push("isTestData");
  if (u.demoReachable === true) tags.push("demoReachable");
  if (u.isLoadTest === true) tags.push("isLoadTest");
  const seedUid = /^u-(marcus|lea|yuki|tom|henrik|ana|jules|selftest|franek-test)/.test(d.id);
  if (seedUid) tags.push("seedUid");

  let bucket = "real";
  if (u.isLoadTest === true) bucket = "loadtest";
  else if (u.isTestData === true) bucket = "test";
  else if (u.demoReachable === true || seedUid) bucket = "demo";

  const line = `  ${d.id}  ·  ${u.displayName ?? "(no name)"}  ·  status=${u.status ?? "?"}  ·  ${reachable ? "REACHABLE" : "unreachable"}  ·  enrich=${u.enrichment?.status ?? "-"}/${u.enrichment?.confidence ?? "-"}  ${tags.length ? "[" + tags.join(",") + "]" : ""}`;
  buckets[bucket].push(line);
}

for (const [name, lines] of Object.entries(buckets)) {
  if (!lines.length) continue;
  console.log(`\n--- ${name.toUpperCase()} (${lines.length}) ---`);
  for (const l of lines) console.log(l);
}

const eventsSnap = await db.collection("events").get();
console.log(`\n=== events: ${eventsSnap.size} total ===`);
for (const d of eventsSnap.docs) {
  const e = d.data();
  const startAt = e.startAt?.toDate?.()?.toISOString() ?? "(no startAt)";
  const tag = e.isTestData === true ? " [isTestData]" : "";
  console.log(`  ${d.id}  ·  ${e.title}  ·  status=${e.status}  ·  ${startAt}  ·  host=${e.hostName ?? e.hostUid ?? "?"}${tag}`);
}

// Other collections that accumulate state.
for (const c of ["inviteCodes", "conversationStates", "botInbox", "whatsappOutbox", "rsvps", "introRequests"]) {
  try {
    const s = await db.collection(c).count().get();
    console.log(`\n[audit] ${c}: ${s.data().count} docs`);
  } catch {
    const s = await db.collection(c).get();
    console.log(`\n[audit] ${c}: ${s.size} docs`);
  }
}

process.exit(0);
