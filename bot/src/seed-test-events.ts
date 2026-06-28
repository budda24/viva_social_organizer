/**
 * One-shot: seed a handful of fake VivaTech-week events so the pre-auth /in
 * landing page renders real Firestore data instead of the in-code sample
 * fallback. Idempotent — re-running overwrites the same doc ids.
 *
 * Hosts reference the test members from seed-test-users.ts (u-lea, u-marcus,
 * u-yuki, u-tom). Run that first so hostUid resolves to a real user.
 *
 * Usage:
 *   npx tsx src/seed-test-events.ts
 *   npx tsx src/seed-test-events.ts --wipe   # delete events from a previous run
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const wipe = process.argv.includes("--wipe");

type EventKind =
  | "breakfast"
  | "coffee"
  | "lunch"
  | "drinks"
  | "dinner"
  | "rooftop"
  | "walk"
  | "side-event"
  | "other";

interface TestEvent {
  id: string;
  title: string;
  kind: EventKind;
  // Days from "tomorrow" (0 = tomorrow) + Paris wall-clock time. Resolved to an
  // absolute timestamp at seed time so the demo always shows UPCOMING events —
  // hardcoded calendar dates go stale and vanish from "what's on" the moment
  // they pass. The original VivaTech-week spread (Wed→Sat) is preserved as
  // offsets 0..3.
  dayOffset: number;
  time: string; // "HH:MM" Paris local
  hostUid: string;
  hostName: string;
  addressNeighborhood?: string;
  addressFull?: string;
  capacity?: number;
  description?: string;
}

// A 4-day spread starting tomorrow — mirrors the original VivaTech-week shape
// (a morning-heavy first day, demos + drinks mid-week, an after-party to close).
const events: TestEvent[] = [
  {
    id: "evt-breakfast-wed",
    title: "Breakfast meet",
    kind: "breakfast",
    dayOffset: 0,
    time: "08:30",
    hostUid: "u-lea",
    hostName: "Léa Mercier",
    addressNeighborhood: "11e",
    addressFull: "Café Oberkampf, 3 Rue Neuve Popincourt",
    capacity: 10,
    description: "First-morning coffee + croissants before doors open.",
  },
  {
    id: "evt-run-thu",
    title: "Morning run · Seine",
    kind: "walk",
    dayOffset: 1,
    time: "07:00",
    hostUid: "u-marcus",
    hostName: "Marcus Højlund",
    addressNeighborhood: "7e",
    addressFull: "Pont de l'Alma, riverside",
    capacity: 12,
    description: "Easy 5k along the Seine. Pace conversational.",
  },
  {
    id: "evt-demos-thu",
    title: "Lightning demos",
    kind: "side-event",
    dayOffset: 1,
    time: "18:30",
    hostUid: "u-tom",
    hostName: "Tom Adebayo",
    addressNeighborhood: "1er",
    addressFull: "Station F satellite space",
    capacity: 30,
    description: "5-minute demos from 6 tribe members. Beers after.",
  },
  {
    id: "evt-wine-thu",
    title: "Wine + agents",
    kind: "drinks",
    dayOffset: 1,
    time: "21:00",
    hostUid: "u-yuki",
    hostName: "Yuki Tanaka",
    addressNeighborhood: "3e",
    addressFull: "Le Mary Celeste, 1 Rue Commines",
    capacity: 14,
    description: "Natural wine bar. Agent-builders welcome, no pitches.",
  },
  {
    id: "evt-walk-lecun-fri",
    title: "Walk to the keynote",
    kind: "walk",
    dayOffset: 2,
    time: "13:30",
    hostUid: "u-yuki",
    hostName: "Yuki Tanaka",
    addressNeighborhood: "15e",
    addressFull: "Porte de Versailles, Hall 1 entrance",
    capacity: 20,
    description: "Walking together to the big talk — meet at the entrance.",
  },
  {
    id: "evt-founders-coffee-fri",
    title: "Founders coffee",
    kind: "coffee",
    dayOffset: 2,
    time: "09:30",
    hostUid: "u-lea",
    hostName: "Léa Mercier",
    addressNeighborhood: "9e",
    addressFull: "Hexagone Café",
    capacity: 8,
    description: "Tight circle — early-stage founders only.",
  },
  {
    id: "evt-lunch-marais-fri",
    title: "Late lunch · Le Marais",
    kind: "lunch",
    dayOffset: 2,
    time: "14:30",
    hostUid: "u-marcus",
    hostName: "Marcus Højlund",
    addressNeighborhood: "4e",
    addressFull: "Chez Janou",
    capacity: 10,
    description: "Long lunch, post-floor decompression.",
  },
  {
    id: "evt-afterparty-sat",
    title: "After-party warm-up",
    kind: "drinks",
    dayOffset: 3,
    time: "19:30",
    hostUid: "u-tom",
    hostName: "Tom Adebayo",
    addressNeighborhood: "11e",
    addressFull: "Andy Wahloo, 69 Rue des Gravilliers",
    capacity: 18,
    description: "Pre-game before the official closing party.",
  },
];

// Resolve a (dayOffset, "HH:MM") pair into an absolute instant at the given
// Paris wall-clock time. Day 0 is tomorrow. The Paris UTC offset is read from
// the target day via Intl, so this is correct across the CET/CEST switch.
const DAY_MS = 24 * 60 * 60 * 1000;

function parisOffset(at: Date): string {
  const tz =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+01:00";
  // "GMT+02:00" → "+02:00"; bare "GMT" (rare) → UTC.
  return tz.replace("GMT", "") || "+00:00";
}

function resolveStartAt(dayOffset: number, time: string): Date {
  const at = new Date(Date.now() + (1 + dayOffset) * DAY_MS);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at); // YYYY-MM-DD in Paris
  return new Date(`${ymd}T${time}:00${parisOffset(at)}`);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

if (wipe) {
  const batch = db.batch();
  for (const e of events) batch.delete(db.doc(`events/${e.id}`));
  await batch.commit();
  console.log(`[seed] wiped ${events.length} test events`);
}

for (const e of events) {
  const ref = db.doc(`events/${e.id}`);
  const startAt = resolveStartAt(e.dayOffset, e.time);
  await ref.set(
    {
      title: e.title,
      kind: e.kind,
      description: e.description ?? "",
      hostUid: e.hostUid,
      hostName: e.hostName,
      startAt: Timestamp.fromDate(startAt),
      addressNeighborhood: e.addressNeighborhood ?? "",
      addressFull: e.addressFull ?? "",
      capacity: e.capacity ?? null,
      allowWaitlist: true,
      visibility: "all",
      status: "scheduled",
      source: "seed",
      isTestData: true,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  // Auto-RSVP the host so the event isn't ghost-attended.
  await ref.collection("rsvps").doc(e.hostUid).set(
    {
      uid: e.hostUid,
      status: "going",
      via: "seed",
      at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(
    `[seed] events/${e.id} → ${e.title} · ${startAt.toISOString()} · host=${e.hostName}`
  );
}

console.log(`[seed] done · ${events.length} upcoming events (starting tomorrow)`);
process.exit(0);
