import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";

initializeApp();
setGlobalOptions({ region: "europe-central2", maxInstances: 10 });

export { redeemInviteCode } from "./invites/redeem";
export { bootstrapUserProfile } from "./users/bootstrap";
export { linkedinSignIn } from "./users/linkedin";
// === Enrichment routed to the LOCAL laptop brain (free Qwen+SearXNG), not the paid
// Sonnet+web_search Cloud Function. Retired 2026-05-30 per Franek: enrichment must be
// local + free. Load test verified the local path matches quality on matching-critical
// fields, attaches no wrong-person data, and is more reliable than this CF was.
// To re-enable the paid CF, uncomment and redeploy. also `firebase functions:delete enrichUser`d.
// export { enrichUser } from "./users/enrich";
export { reclaimStaleInbox } from "./bot/reclaimInbox";

// === Twilio WhatsApp (Sandbox) — fallback channel ===
export { twilioWebhook } from "./channels/twilio/webhook";
export { onTwilioOutboxCreated } from "./channels/twilio/outbox";

// === Telegram — primary channel ===
export { telegramWebhook } from "./channels/telegram/webhook";
export { onTelegramOutboxCreated } from "./channels/telegram/outbox";

// === Whapi.cloud path — disabled until Whapi account + WHAPI_TOKEN / WHAPI_WEBHOOK_SECRET are configured ===
// export { whapiWebhook } from "./bot/webhook";
// export { drainOutbox, onOutboxCreated } from "./messaging/outbox";

// === Fallback brain — disabled until ANTHROPIC_API_KEY secret is set in Firebase ===
// export { fallbackBrain } from "./bot/fallbackBrain";
