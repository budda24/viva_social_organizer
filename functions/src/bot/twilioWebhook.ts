import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";

const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");

// Twilio signs the exact public URL it called. Inside Firebase Functions v2
// the Host header is the internal Cloud Run service hostname, not the public
// *.cloudfunctions.net URL Twilio used — so reconstructing from headers fails
// signature validation. Hardcode the public URL Twilio is configured to call.
const PUBLIC_URL =
  process.env.TWILIO_WEBHOOK_PUBLIC_URL ??
  "https://europe-central2-viva-social-organizer.cloudfunctions.net/twilioWebhook";

/**
 * Twilio WhatsApp inbound webhook.
 *
 * Twilio POSTs application/x-www-form-urlencoded with fields like:
 *   From: "whatsapp:+48531941333"
 *   To:   "whatsapp:+14155238886"
 *   Body: "<message text>"
 *   MessageSid: "SM..."
 *   ProfileName: "<sender's WhatsApp name>"
 *
 * We validate the X-Twilio-Signature, resolve phone → user, write a botInbox row
 * the same shape the laptop brain already expects, and return TwiML 200 fast.
 */
export const twilioWebhook = onRequest(
  { secrets: [TWILIO_AUTH_TOKEN], region: "europe-central2", invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const signature = req.header("x-twilio-signature") ?? "";
    const valid = twilio.validateRequest(
      TWILIO_AUTH_TOKEN.value(),
      signature,
      PUBLIC_URL,
      req.body ?? {}
    );
    if (!valid) {
      console.warn(
        `[twilioWebhook] bad signature. expected url=${PUBLIC_URL}, ` +
          `host header=${req.header("host")}, x-forwarded-host=${req.header("x-forwarded-host")}, ` +
          `originalUrl=${req.originalUrl}`
      );
      res.status(403).send("Bad signature");
      return;
    }

    const from = String(req.body?.From ?? "");
    const body = String(req.body?.Body ?? "").trim();
    const messageSid = String(req.body?.MessageSid ?? "");
    const profileName = String(req.body?.ProfileName ?? "");

    if (!from.startsWith("whatsapp:") || !body || !messageSid) {
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    const phone = from.replace(/^whatsapp:/, "");
    const db = getFirestore();

    const userSnap = await db
      .collection("users")
      .where("whatsappPhoneE164", "==", phone)
      .limit(1)
      .get();

    if (userSnap.empty) {
      console.warn(`[twilioWebhook] no user for phone ${phone}; ignoring`);
      // Empty TwiML — Twilio won't reply to the user.
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    const userDoc = userSnap.docs[0];
    if (userDoc.data().status !== "approved") {
      console.warn(`[twilioWebhook] user ${userDoc.id} not approved`);
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    await db.doc(`botInbox/${messageSid}`).set(
      {
        messageId: messageSid,
        provider: "twilio",
        phone,
        profileName,
        uid: userDoc.id,
        body,
        receivedAt: FieldValue.serverTimestamp(),
        status: "pending",
        attempts: 0,
      },
      { merge: true }
    );

    // Reply with empty TwiML — the actual reply gets sent later via the outbox
    // (Claude takes longer than Twilio's webhook timeout).
    res.status(200).type("text/xml").send("<Response/>");
  }
);
