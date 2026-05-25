/**
 * Concurrency load test for the laptop bot brain.
 *
 * Generates N synthetic test users on the fly (each with a plausible profile
 * so Tribu has something to match against), drops N botInbox rows
 * simultaneously, then watches them get processed. Reports throughput and
 * effective parallelism.
 *
 * Run in another terminal while `npm run dev` is active:
 *
 *   npx tsx src/load-test.ts --count 10                # quick run, leaves test docs
 *   npx tsx src/load-test.ts --count 50 --cleanup      # bigger, auto-cleanup after
 *   npx tsx src/load-test.ts --count 100 --cleanup     # stress: 100 simultaneous
 *   npx tsx src/load-test.ts --cleanup-only            # wipe leftover docs from prior runs
 *
 * Synthetic users:
 *   - uid format: `lt-<runId>-<index>`
 *   - status: approved, onboarding.step: complete (so brain skips Q&A)
 *   - tagged isLoadTest: true on users, botInbox, whatsappOutbox
 *   - cleanup wipes by tag, idempotent
 *
 * The brain's outbox writes will fail to deliver (synthetic chatId), but
 * that's intentional — we're measuring brain throughput, not message
 * delivery. Outbox failures are normal here.
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const MAX_SAFETY_COUNT = 200;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const COUNT = Number(arg("count", "10"));
const DO_CLEANUP_AFTER = flag("cleanup");
const CLEANUP_ONLY = flag("cleanup-only");
const TIMEOUT_MS = Number(arg("timeout", "300000")); // 5 min default for big runs
const BATCH_SIZE = 500;

// Profile variety pools — synthetic users rotate through these so the
// member directory has realistic spread.
const ROLES = ["founder", "VC", "engineer", "designer", "growth lead", "ops lead", "researcher", "PM"];
const DOMAINS = [
  "AI",
  "fintech",
  "climate-tech",
  "devtools",
  "hardware",
  "marketplaces",
  "B2B SaaS",
  "consumer",
  "health-tech",
  "agents",
];
const CITIES = ["London", "Paris", "Berlin", "Amsterdam", "Stockholm", "Lisbon", "Madrid", "Warsaw"];
const GOALS = [
  "meet European AI VCs",
  "find a co-founder",
  "sell to enterprise CFOs",
  "find design partner customers",
  "meet other founders building agents",
  "raise a seed round",
  "find engineering co-founder",
  "scout pre-seed deals",
];
const ENERGIES: Array<"1on1" | "group" | "both"> = ["1on1", "group", "both"];

const TEST_MESSAGES = [
  "find me a buddy",
  "find me an AI VC",
  "who is here",
  "find me a climate founder",
  "find me marketplace people",
  "find me an AI infra person",
  "find me a hardware engineer",
  "free for 30",
  "help",
  "find someone working on agents",
];

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

async function batchedDelete(refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.delete(ref);
    await batch.commit();
  }
}

async function cleanup(): Promise<{ users: number; inbox: number; outbox: number; convoStates: number }> {
  const [usersSnap, inboxSnap, outboxSnap] = await Promise.all([
    db.collection("users").where("isLoadTest", "==", true).get(),
    db.collection("botInbox").where("isLoadTest", "==", true).get(),
    db.collection("whatsappOutbox").where("isLoadTest", "==", true).get(),
  ]);

  // Conversation states for synthetic uids — query by doc ID prefix.
  const convoSnap = await db
    .collection("conversationStates")
    .orderBy("__name__")
    .startAt("lt-")
    .endAt("lt-")
    .get();

  await Promise.all([
    batchedDelete(usersSnap.docs.map((d) => d.ref)),
    batchedDelete(inboxSnap.docs.map((d) => d.ref)),
    batchedDelete(outboxSnap.docs.map((d) => d.ref)),
    batchedDelete(convoSnap.docs.map((d) => d.ref)),
  ]);

  return {
    users: usersSnap.size,
    inbox: inboxSnap.size,
    outbox: outboxSnap.size,
    convoStates: convoSnap.size,
  };
}

async function heartbeatFresh(): Promise<{ fresh: boolean; ageSec?: number; maxConcurrent?: number }> {
  const hb = await db.doc("system/botHeartbeat").get();
  const data = hb.data();
  const ts = data?.lastSeenAt as Timestamp | undefined;
  if (!ts) return { fresh: false };
  const ageSec = (Date.now() - ts.toMillis()) / 1000;
  return {
    fresh: ageSec < 60,
    ageSec,
    maxConcurrent: data?.maxConcurrent as number | undefined,
  };
}

interface SyntheticProfile {
  uid: string;
  displayName: string;
  bio: string;
  topics: string[];
  goal: string;
  energy: "1on1" | "group" | "both";
  city: string;
}

function buildProfile(runId: number, i: number): SyntheticProfile {
  const role = ROLES[i % ROLES.length];
  const domain = DOMAINS[i % DOMAINS.length];
  const adjacent = DOMAINS[(i + 3) % DOMAINS.length];
  return {
    uid: `lt-${runId}-${String(i).padStart(3, "0")}`,
    displayName: `LoadTest ${i + 1}`,
    bio: `${role} in ${domain}`,
    topics: [domain, adjacent, "Europe"],
    goal: GOALS[i % GOALS.length],
    energy: ENERGIES[i % ENERGIES.length],
    city: CITIES[i % CITIES.length],
  };
}

// === Entry ===

if (CLEANUP_ONLY) {
  const c = await cleanup();
  console.log(
    `[load-test] cleanup-only: deleted ${c.users} users, ${c.inbox} inbox, ${c.outbox} outbox, ${c.convoStates} convo states`
  );
  process.exit(0);
}

if (!Number.isFinite(COUNT) || COUNT < 1) {
  console.error("--count must be a positive integer");
  process.exit(2);
}
if (COUNT > MAX_SAFETY_COUNT) {
  console.error(
    `--count > ${MAX_SAFETY_COUNT} blocked. Raise MAX_SAFETY_COUNT in the script if intentional.`
  );
  process.exit(2);
}

const hb = await heartbeatFresh();
if (!hb.fresh) {
  console.warn(
    `[load-test] ⚠️  bot heartbeat is stale${
      hb.ageSec !== undefined ? ` (last seen ${hb.ageSec.toFixed(0)}s ago)` : ""
    } or missing — is \`npm run dev\` running?`
  );
  console.warn("  Continuing anyway. Brain must be up for messages to be processed.\n");
} else {
  console.log(
    `[load-test] brain alive (last seen ${hb.ageSec?.toFixed(0)}s ago, MAX_CONCURRENT=${
      hb.maxConcurrent ?? "?"
    })`
  );
}

const runId = Date.now();
console.log(`[load-test] runId=${runId} · creating ${COUNT} synthetic users with profiles...`);

// === 1. Create synthetic users in batches ===
const profiles = Array.from({ length: COUNT }, (_, i) => buildProfile(runId, i));
const userSetupStart = Date.now();

for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
  const batch = db.batch();
  for (const p of profiles.slice(i, i + BATCH_SIZE)) {
    batch.set(db.doc(`users/${p.uid}`), {
      displayName: p.displayName,
      bio: p.bio,
      topics: p.topics,
      goal: p.goal,
      energy: p.energy,
      city: p.city,
      status: "approved",
      role: "member",
      isLoadTest: true,
      runId,
      onboarding: { step: "complete" },
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}
const userSetupMs = Date.now() - userSetupStart;
console.log(`[load-test] ${COUNT} users created in ${userSetupMs}ms`);

// === 2. Drop N botInbox rows simultaneously ===
const docIds: string[] = [];
const messages: string[] = [];
console.log(`[load-test] dropping ${COUNT} inbox rows simultaneously...`);
const dropStart = Date.now();

// Fire all writes in parallel (Firestore handles burst fine).
await Promise.all(
  profiles.map((p, i) => {
    const messageId = `load-test-${runId}-${String(i).padStart(3, "0")}`;
    const body = TEST_MESSAGES[i % TEST_MESSAGES.length];
    docIds.push(messageId);
    messages.push(body);
    return db.doc(`botInbox/${messageId}`).set({
      messageId,
      provider: "telegram",
      uid: p.uid,
      chatId: 999_000_000 + i, // fake; outbox will fail to deliver, that's fine
      body,
      receivedAt: FieldValue.serverTimestamp(),
      status: "pending",
      attempts: 0,
      isLoadTest: true,
      runId,
    });
  })
);

const dropElapsed = Date.now() - dropStart;
console.log(`[load-test] dropped in ${dropElapsed}ms. Watching for completion...\n`);

// === 3. Poll until terminal ===
const perDocStart = new Map<string, number>();
const perDocDone = new Map<string, number>();
const processStart = Date.now();
let peakInFlight = 0;
let lastPrint = "";

while (true) {
  // Fetch in chunks of 30 (Firestore in-query cap on doc IDs).
  const allSnaps: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let i = 0; i < docIds.length; i += 30) {
    const chunk = docIds.slice(i, i + 30);
    const snaps = await Promise.all(chunk.map((id) => db.doc(`botInbox/${id}`).get()));
    allSnaps.push(...snaps);
  }

  const statuses: Record<string, number> = {};
  for (let i = 0; i < allSnaps.length; i++) {
    const s = allSnaps[i].data()?.status ?? "missing";
    statuses[s] = (statuses[s] ?? 0) + 1;
    if (s === "processing" && !perDocStart.has(docIds[i])) {
      perDocStart.set(docIds[i], Date.now());
    }
    if ((s === "done" || s === "failed") && !perDocDone.has(docIds[i])) {
      perDocDone.set(docIds[i], Date.now());
    }
  }
  if (statuses.processing && statuses.processing > peakInFlight) {
    peakInFlight = statuses.processing;
  }

  const elapsed = ((Date.now() - processStart) / 1000).toFixed(1);
  const line = `[load-test] ${elapsed}s · ${JSON.stringify(statuses)} · ${perDocDone.size}/${COUNT} done · peakInFlight=${peakInFlight}`;
  if (line !== lastPrint) {
    process.stdout.write("\r" + line.padEnd(110));
    lastPrint = line;
  }

  const allTerminal = allSnaps.every(
    (s) => s.data()?.status === "done" || s.data()?.status === "failed"
  );
  if (allTerminal) {
    process.stdout.write("\n\n");
    break;
  }

  if (Date.now() - processStart > TIMEOUT_MS) {
    console.error(`\n[load-test] timeout after ${TIMEOUT_MS}ms — some messages never finished`);
    break;
  }

  await new Promise((r) => setTimeout(r, 500));
}

// === 4. Summary ===
const total = (Date.now() - processStart) / 1000;
const perDocTimes = docIds
  .map((id) => {
    const start = perDocStart.get(id);
    const end = perDocDone.get(id);
    return start && end ? (end - start) / 1000 : null;
  })
  .filter((v): v is number => v !== null);

const min = perDocTimes.length ? Math.min(...perDocTimes) : 0;
const max = perDocTimes.length ? Math.max(...perDocTimes) : 0;
const avg = perDocTimes.length
  ? perDocTimes.reduce((a, b) => a + b, 0) / perDocTimes.length
  : 0;
const median = perDocTimes.length
  ? [...perDocTimes].sort((a, b) => a - b)[Math.floor(perDocTimes.length / 2)]
  : 0;

// Final status pass — same chunked fetch.
const finalSnaps: FirebaseFirestore.DocumentSnapshot[] = [];
for (let i = 0; i < docIds.length; i += 30) {
  const chunk = docIds.slice(i, i + 30);
  const snaps = await Promise.all(chunk.map((id) => db.doc(`botInbox/${id}`).get()));
  finalSnaps.push(...snaps);
}
const failed = finalSnaps.filter((s) => s.data()?.status === "failed").length;
const done = finalSnaps.filter((s) => s.data()?.status === "done").length;

console.log("═══════════════ Summary ═══════════════");
console.log(`messages:                  ${COUNT}`);
console.log(`done:                      ${done}`);
console.log(`failed:                    ${failed}`);
console.log(`peak inFlight (observed):  ${peakInFlight}`);
console.log(`total wall time:           ${total.toFixed(2)}s`);
console.log(`per-message min/med/avg/max: ${min.toFixed(1)}s / ${median.toFixed(1)}s / ${avg.toFixed(1)}s / ${max.toFixed(1)}s`);
const serialBaseline = avg * COUNT;
console.log(`serial baseline (avg × N): ${serialBaseline.toFixed(2)}s`);
const speedup = serialBaseline > 0 ? serialBaseline / total : 0;
console.log(`effective parallelism:     ${speedup.toFixed(2)}x`);
const throughputPerMin = total > 0 ? (done * 60) / total : 0;
console.log(`throughput:                ${throughputPerMin.toFixed(1)} msg/min`);
console.log(`Anthropic cost (Haiku):    $${(done * 0.006).toFixed(2)} (rough estimate)`);

if (failed > 0) {
  console.log(`\n${failed} message(s) failed. First few errors:`);
  let shown = 0;
  for (let i = 0; i < finalSnaps.length && shown < 5; i++) {
    const d = finalSnaps[i].data();
    if (d?.status === "failed") {
      console.log(`  - ${docIds[i]} ("${messages[i]}"): ${d.lastError ?? "<no error>"}`);
      shown++;
    }
  }
  if (failed > 5) console.log(`  ...and ${failed - 5} more`);
}

if (DO_CLEANUP_AFTER) {
  const c = await cleanup();
  console.log(
    `\n[load-test] cleanup: deleted ${c.users} users, ${c.inbox} inbox, ${c.outbox} outbox, ${c.convoStates} convo states`
  );
} else {
  console.log(`\n[load-test] leaving test docs in place. Wipe with: npx tsx src/load-test.ts --cleanup-only`);
}

process.exit(0);
