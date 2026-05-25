import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";

const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_WHATSAPP_FROM = defineSecret("TWILIO_WHATSAPP_FROM");

const MAX_ATTEMPTS = 3;

/**
 * Send outbox rows tagged provider=twilio via the Twilio WhatsApp API.
 * Fires on creation of whatsappOutbox/{messageId} rows. Mirrors the existing
 * Whapi-based onOutboxCreated but routes through Twilio.
 *
 * Note: Twilio Sandbox only delivers to numbers that have opted in
 * (sent "join <code>" once). Outside the 24-hour user-initiated window,
 * free-form messages are blocked — you need pre-approved templates.
 */
export const onTwilioOutboxCreated = onDocumentCreated(
  {
    document: "whatsappOutbox/{messageId}",
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM],
    region: "europe-central2",
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.provider !== "twilio") return;
    if (data.status !== "queued") return;

    const db = getFirestore();
    const ref = event.data!.ref;

    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.data();
      if (!d || d.status !== "queued") return null;
      tx.update(ref, { status: "sending", attempts: FieldValue.increment(1) });
      return d;
    });
    if (!claimed) return;

    try {
      const client = twilio(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
      const result = await client.messages.create({
        from: TWILIO_WHATSAPP_FROM.value(),
        to: `whatsapp:${claimed.recipientPhone}`,
        body: String(claimed.body ?? "").slice(0, 1500),
      });

      await ref.update({
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageSid: result.sid,
      });

      await db.doc(`whatsappLog/${event.params.messageId}`).set({
        ...claimed,
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageSid: result.sid,
      });
    } catch (e: any) {
      const attempts = (claimed.attempts ?? 0) + 1;
      const final = attempts >= MAX_ATTEMPTS;
      const message = e?.message ?? String(e);
      console.error(`[twilioOutbox] send failed (attempt ${attempts}): ${message}`);
      await ref.update({
        status: final ? "failed" : "queued",
        lastError: message,
      });
    }
  }
);
