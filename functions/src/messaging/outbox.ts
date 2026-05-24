import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const WHAPI_TOKEN = defineSecret("WHAPI_TOKEN");

const URGENT_TYPES = new Set(["welcome", "buddy_intro", "bot_reply"]);
const MAX_ATTEMPTS = 3;
const STAGGER_MS = 3000;
const DAILY_CAP = 500;
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 8;

async function isInQuietHours(): Promise<boolean> {
  const now = new Date();
  const parisHour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "Europe/Paris",
    }).format(now)
  );
  return parisHour >= QUIET_HOURS_START || parisHour < QUIET_HOURS_END;
}

async function checkDailyCap(): Promise<boolean> {
  const db = getFirestore();
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.doc(`whatsappMeta/dayCounter_${today}`);
  const snap = await ref.get();
  const sent = (snap.data()?.sent ?? 0) as number;
  return sent < DAILY_CAP;
}

async function incrementDailyCap(): Promise<void> {
  const db = getFirestore();
  const today = new Date().toISOString().slice(0, 10);
  await db.doc(`whatsappMeta/dayCounter_${today}`).set(
    { sent: FieldValue.increment(1) },
    { merge: true }
  );
}

async function sendOne(messageId: string, token: string): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`whatsappOutbox/${messageId}`);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!d || d.status !== "queued") return null;
    tx.update(ref, {
      status: "sending",
      attempts: FieldValue.increment(1),
    });
    return d;
  });
  if (!claimed) return;

  try {
    const body =
      claimed.recipientType === "group"
        ? { to: `${claimed.recipientGroupId}@g.us`, body: claimed.body }
        : { to: String(claimed.recipientPhone).replace(/[^0-9]/g, ""), body: claimed.body };

    const res = await fetch("https://gate.whapi.cloud/messages/text", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`whapi ${res.status}: ${await res.text()}`);
    }

    await ref.update({ status: "sent", sentAt: FieldValue.serverTimestamp() });
    await db.doc(`whatsappLog/${messageId}`).set({
      ...claimed,
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
    });
    await incrementDailyCap();
  } catch (e: any) {
    const attempts = (claimed.attempts ?? 0) + 1;
    const final = attempts >= MAX_ATTEMPTS;
    await ref.update({
      status: final ? "failed" : "queued",
      lastError: String(e?.message ?? e),
      scheduledFor: final ? null : Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    });
  }
}

/** Urgent sends: fire on outbox row creation if type is urgent. */
export const onOutboxCreated = onDocumentCreated(
  {
    document: "whatsappOutbox/{messageId}",
    secrets: [WHAPI_TOKEN],
    region: "europe-central2",
  },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.status !== "queued") return;
    if (!URGENT_TYPES.has(data.type)) return;
    if (data.scheduledFor && (data.scheduledFor as Timestamp).toMillis() > Date.now()) return;
    if (await isInQuietHours()) return;
    if (!(await checkDailyCap())) return;
    const jitter = Math.floor(Math.random() * 2000);
    await new Promise((r) => setTimeout(r, jitter));
    await sendOne(event.params.messageId, WHAPI_TOKEN.value());
  }
);

/** Scheduled drainer: bulk sends, staggered, every minute. */
export const drainOutbox = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "europe-central2",
    timeZone: "Europe/Paris",
    secrets: [WHAPI_TOKEN],
  },
  async () => {
    if (await isInQuietHours()) return;
    if (!(await checkDailyCap())) return;

    const db = getFirestore();
    const now = Timestamp.now();
    const batch = await db
      .collection("whatsappOutbox")
      .where("status", "==", "queued")
      .where("scheduledFor", "<=", now)
      .orderBy("scheduledFor")
      .limit(20)
      .get();

    for (const doc of batch.docs) {
      await sendOne(doc.id, WHAPI_TOKEN.value());
      await new Promise((r) => setTimeout(r, STAGGER_MS));
      if (!(await checkDailyCap())) break;
    }
  }
);
