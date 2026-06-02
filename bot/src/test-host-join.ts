/**
 * Focused regression test for the "host sees Join button for their own event" bug.
 *
 * Runs the REAL `buildWhatsOnReply` and `handleJoin` against a hand-rolled fake
 * Firestore (no emulator needed) and asserts:
 *   1. what's-on offers NO Join button for an event the caller hosts (but still
 *      lists it, tagged "you host"), and DOES offer one for others' events.
 *   2. handleJoin refuses a host RSVP'ing their own event (typed/tapped path),
 *      and still lets a non-host join.
 *
 * Run: npx tsx src/test-host-join.ts
 */
import type { Firestore } from "firebase-admin/firestore";
import type { OutboxButton } from "./actions.js";
import { buildWhatsOnReply, handleJoin } from "./brain.js";

const HOST = "userA";
const OTHER = "userB";
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000; // tomorrow

interface FakeEvent {
  id: string;
  title: string;
  hostUid: string;
  status: string;
}
const EVENTS: FakeEvent[] = [
  { id: "ev1", title: "Drink Night", hostUid: HOST, status: "scheduled" },
  { id: "ev2", title: "Breakfast meet", hostUid: OTHER, status: "scheduled" },
];

const ts = (ms: number) => ({ toMillis: () => ms });
function docData(e: FakeEvent) {
  return {
    title: e.title,
    kind: "drinks",
    status: e.status,
    hostUid: e.hostUid,
    hostName: e.hostUid === HOST ? "Alice" : "Bob",
    addressNeighborhood: "downtown",
    addressFull: "12 Rue de Test",
    description: "",
    startAt: ts(FUTURE_MS),
  };
}

const rsvpWrites: Array<{ event: string; uid: string }> = [];

// Minimal Firestore shim covering only what the two functions touch.
function makeDb(): Firestore {
  const eventDoc = (id: string) => {
    const e = EVENTS.find((x) => x.id === id);
    return {
      get: async () => ({
        exists: !!e,
        id,
        data: () => (e ? docData(e) : undefined),
      }),
      collection: (_sub: string) => ({
        doc: (uid: string) => ({
          set: async () => {
            rsvpWrites.push({ event: id, uid });
          },
        }),
      }),
    };
  };
  return {
    collection: (name: string) => {
      if (name !== "events") throw new Error(`unexpected collection ${name}`);
      return {
        where: (_f: string, _op: string, _v: string) => ({
          get: async () => ({
            docs: EVENTS.map((e) => ({ id: e.id, data: () => docData(e) })),
          }),
        }),
        doc: (id: string) => eventDoc(id),
      };
    },
    doc: (path: string) => eventDoc(path.replace(/^events\//, "")),
  } as unknown as Firestore;
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const db = makeDb();

  console.log("buildWhatsOnReply — caller is host of ev1 (Drink Night):");
  const r = await buildWhatsOnReply(db, HOST, "en");
  const datas = (r.buttons ?? []).map((b: OutboxButton) => b.data);
  check("no Join button for hosted ev1", !datas.includes("join ev1"), `buttons=${JSON.stringify(datas)}`);
  check("Join button present for others' ev2", datas.includes("join ev2"));
  check("hosted event still listed", /Drink Night/.test(r.telegramBody));
  check('hosted line tagged "(you host)"', /Drink Night.*\(you host\)/.test(r.telegramBody), r.telegramBody);

  console.log("buildWhatsOnReply — caller is NOT host (other user):");
  const r2 = await buildWhatsOnReply(db, "someoneElse", "en");
  const datas2 = (r2.buttons ?? []).map((b: OutboxButton) => b.data);
  check("Join buttons for both events", datas2.includes("join ev1") && datas2.includes("join ev2"));

  console.log("handleJoin — host tries to join own ev1:");
  const j1 = await handleJoin(db, HOST, "ev1", "en");
  check("rejected (joined=false)", j1.joined === false);
  check("no RSVP written", !rsvpWrites.some((w) => w.uid === HOST && w.event === "ev1"));
  check("reply mentions hosting", /hosting/i.test(j1.reply), j1.reply);

  console.log("handleJoin — non-host joins ev1:");
  const j2 = await handleJoin(db, OTHER, "ev1", "en");
  check("accepted (joined=true)", j2.joined === true);
  check("RSVP written", rsvpWrites.some((w) => w.uid === OTHER && w.event === "ev1"));

  console.log("handleJoin — host typed the title instead of tapping:");
  const j3 = await handleJoin(db, HOST, "Drink Night", "en");
  check("title path also rejected", j3.joined === false);

  console.log("");
  if (failures === 0) {
    console.log("ALL PASS ✅");
  } else {
    console.log(`${failures} FAILURE(S) ❌`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
