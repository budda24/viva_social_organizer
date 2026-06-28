import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { resolveUserByChannel } from "../identity";
import { checkAndIncrement } from "../rateLimit";
import { demoWelcome } from "../demo";

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
      // Self-serve WhatsApp demo: an unbound number reaching the Twilio sandbox
      // is a prospect (real members bind their phone on the site, so they'd
      // resolve above). Auto-onboard them into the same sealed demo sandbox as
      // Telegram's `/start demo` and greet — then stop. Their next message
      // resolves to this demo account and flows through the brain normally.
      await handleDemoStartWhatsApp(phone, profileName);
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

/**
 * WhatsApp equivalent of the Telegram `/start demo` flow. Mints (or refreshes)
 * an ephemeral `isDemo` user keyed to the phone, binds it via whatsappPhoneE164
 * so the brain can route replies back, marks onboarding complete, and queues the
 * demo welcome through the Twilio outbox. Idempotent. WhatsApp gives no locale,
 * so the welcome defaults to English (the prospect can switch with `language`).
 */
async function handleDemoStartWhatsApp(
  phone: string,
  profileName: string
): Promise<void> {
  const db = getFirestore();
  const uid = `demo-wa-${phone.replace(/[^0-9]/g, "")}`;
  const userRef = db.doc(`users/${uid}`);
  const existing = (await userRef.get()).data();
  const name = profileName || (existing?.displayName as string | undefined) || "Guest";
  const lang = (existing?.preferredLanguage as string | undefined) === "fr" ? "fr" : "en";

  await userRef.set(
    {
      displayName: name,
      status: "approved",
      role: "member",
      isDemo: true,
      whatsappPhoneE164: phone,
      consentWhatsappMessages: true,
      preferredLanguage: lang,
      onboarding: { step: "complete", completedAt: FieldValue.serverTimestamp() },
      createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.collection("whatsappOutbox").add({
    recipientType: "individual",
    recipientUid: uid,
    recipientPhone: phone,
    type: "demo_welcome",
    provider: "twilio",
    body: demoWelcome(lang, name),
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
}
