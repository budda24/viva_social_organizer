import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { resolveUserByChannel } from "../identity";
import { checkAndIncrement } from "../rateLimit";

const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");

// Twilio signs the exact public URL it called. Inside Firebase Functions v2
// the Host header is the internal Cloud Run service hostname, not the public
// *.cloudfunctions.net URL Twilio used — so reconstructing from headers fails
// signature validation. Hardcode the public URL Twilio is configured to call.
const PUBLIC_URL =
  process.env.TWILIO_WEBHOOK_PUBLIC_URL ??
  "https://europe-central2-viva-social-organizer.cloudfunctions.net/twilioWebhook";

function ackEmpty(res: import("express").Response) {
  res.status(200).type("text/xml").send("<Response/>");
}

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
 * Validate X-Twilio-Signature, resolve phone → user, check rate limit, write
 * a botInbox row, return TwiML 200 fast. The reply is sent later via outbox
 * because Claude takes longer than Twilio's webhook timeout.
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
      ackEmpty(res);
      return;
    }

    const phone = from.replace(/^whatsapp:/, "");
    const user = await resolveUserByChannel("twilio", phone);
    if (!user) {
      console.warn(`[twilioWebhook] no approved user for phone ${phone}; ignoring`);
      ackEmpty(res);
      return;
    }

    const rate = await checkAndIncrement("twilio", user.uid);
    if (!rate.allowed) {
      console.warn(
        `[twilioWebhook] rate-limited uid=${user.uid} reason=${rate.reason} retryAfter=${rate.retryAfterSec}s`
      );
      ackEmpty(res);
      return;
    }

    const db = getFirestore();
    await db.doc(`botInbox/${messageSid}`).set(
      {
        messageId: messageSid,
        provider: "twilio",
        phone,
        profileName,
        uid: user.uid,
        body,
        receivedAt: FieldValue.serverTimestamp(),
        status: "pending",
        attempts: 0,
      },
      { merge: true }
    );

    ackEmpty(res);
  }
);
