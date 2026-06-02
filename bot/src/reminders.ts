/**
 * Event reminders — nudges every RSVP'd attendee once, ~24h before an event
 * starts. Runs as a periodic tick from index.ts (the laptop brain is up for the
 * event, same place the enrichment tick lives).
 *
 * Dedupe is via events/{id}.reminderSentAt, claimed in a transaction so two
 * workers (or two ticks) never double-send.
 */
import { Firestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { pickChannel, enqueueOutbox } from "./actions.js";
import { msg, normalizeLang } from "./i18n.js";

// Send the reminder once the event is within this lead time (and still future).
const REMIND_LEAD_MS = Number(process.env.REMIND_LEAD_MS ?? 24 * 60 * 60 * 1000);

function formatParis(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export async function reminderTick(db: Firestore): Promise<void> {
  const now = Date.now();
  const snap = await db.collection("events").where("status", "==", "scheduled").get();

  for (const doc of snap.docs) {
    const e = doc.data();
    if (e.reminderSentAt) continue; // already reminded
    const startAt = e.startAt as Timestamp | undefined;
    const startMs =
      startAt && typeof startAt.toMillis === "function" ? startAt.toMillis() : 0;
    if (!startMs) continue;
    const lead = startMs - now;
    if (lead <= 0 || lead > REMIND_LEAD_MS) continue; // not in the 0–24h window

    // Claim the event so only one tick sends its reminder.
    const claimed = await db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      const d = s.data();
      if (!d || d.status !== "scheduled" || d.reminderSentAt) return false;
      tx.update(doc.ref, { reminderSentAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) continue;

    const title = String(e.title ?? "the event");
    const when = formatParis(startMs);
    const place = String(e.addressFull || e.addressNeighborhood || "");

    const rsvps = await doc.ref.collection("rsvps").where("status", "==", "going").get();
    await Promise.all(
      rsvps.docs.map(async (r) => {
        const us = await db.doc(`users/${r.id}`).get();
        if (!us.exists) return;
        const ud = us.data() ?? {};
        const route = pickChannel(ud);
        if (!route) return;
        const lang = normalizeLang(ud.preferredLanguage);
        await enqueueOutbox(db, {
          recipientUid: r.id,
          route,
          body: msg(lang).eventReminder(title, `${when} Paris`, place),
          type: "event_reminder",
          eventId: doc.id,
        });
      })
    );
    console.log(`[reminders] sent reminder for ${doc.id} (${title}) to ${rsvps.size} attendee(s)`);
  }
}
