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
  startAtISO: string; // Paris time, +02:00 in June
  hostUid: string;
  hostName: string;
  addressNeighborhood?: string;
  addressFull?: string;
  capacity?: number;
  description?: string;
}

// VivaTech Paris 2026: Wed 17 — Sat 20 Jun. Mirrors the in-code sampleEvents.
const events: TestEvent[] = [
  {
    id: "evt-breakfast-wed",
    title: "Breakfast meet",
    kind: "breakfast",
    startAtISO: "2026-06-17T08:30:00+02:00",
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
    startAtISO: "2026-06-18T07:00:00+02:00",
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
    startAtISO: "2026-06-18T18:30:00+02:00",
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
    startAtISO: "2026-06-18T21:00:00+02:00",
    hostUid: "u-yuki",
    hostName: "Yuki Tanaka",
    addressNeighborhood: "3e",
    addressFull: "Le Mary Celeste, 1 Rue Commines",
    capacity: 14,
    description: "Natural wine bar. Agent-builders welcome, no pitches.",
  },
  {
    id: "evt-walk-lecun-fri",
    title: "Walk to LeCun keynote",
    kind: "walk",
    startAtISO: "2026-06-19T13:30:00+02:00",
    hostUid: "u-yuki",
    hostName: "Yuki Tanaka",
    addressNeighborhood: "15e",
    addressFull: "Porte de Versailles, Hall 1 entrance",
    capacity: 20,
    description: "Walking together to the LeCun talk — meet at the entrance.",
  },
  {
    id: "evt-founders-coffee-fri",
    title: "Founders coffee",
    kind: "coffee",
    startAtISO: "2026-06-19T09:30:00+02:00",
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
    startAtISO: "2026-06-19T14:30:00+02:00",
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
    startAtISO: "2026-06-20T19:30:00+02:00",
    hostUid: "u-tom",
    hostName: "Tom Adebayo",
    addressNeighborhood: "11e",
    addressFull: "Andy Wahloo, 69 Rue des Gravilliers",
    capacity: 18,
    description: "Pre-game before the official closing party.",
  },
];

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
  await ref.set(
    {
      title: e.title,
      kind: e.kind,
      description: e.description ?? "",
      hostUid: e.hostUid,
      hostName: e.hostName,
      startAt: Timestamp.fromDate(new Date(e.startAtISO)),
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
  console.log(`[seed] events/${e.id} → ${e.title} · ${e.startAtISO} · host=${e.hostName}`);
}

console.log(`[seed] done · ${events.length} events scheduled for VivaTech week`);
process.exit(0);
