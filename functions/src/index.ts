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
// Pages Franek (Telegram DM + Slack) when the laptop brain goes down — stale
// heartbeat (laptop/bot offline) or a fresh beat reporting ollamaOk === false.
export { brainWatchdog } from "./bot/watchdog";

// === Public landing-page member count ===
// Maintains public/stats.memberCount so the signed-out "/" landing can show a
// live "N tribers" pill without exposing the sign-in-gated directory.
export { onUserWrite } from "./stats/memberCount";

// === Twilio WhatsApp (Sandbox) — fallback channel ===
export { twilioWebhook } from "./channels/twilio/webhook";
export { onTwilioOutboxCreated } from "./channels/twilio/outbox";

// === Telegram — primary channel ===
export { telegramWebhook } from "./channels/telegram/webhook";
export { onTelegramOutboxCreated } from "./channels/telegram/outbox";
// Per-event forum topic in the "Viva Tribe" supergroup (Topics enabled). Needs
// TELEGRAM_GROUP_CHAT_ID + (TELEGRAM_GROUP_USERNAME | TELEGRAM_GROUP_INVITE) set;
// no-ops until then.
export { onEventWrite } from "./channels/telegram/forum";

// === Whapi.cloud path — disabled until Whapi account + WHAPI_TOKEN / WHAPI_WEBHOOK_SECRET are configured ===
// export { whapiWebhook } from "./bot/webhook";
// export { drainOutbox, onOutboxCreated } from "./messaging/outbox";

// === Fallback brain — disabled until ANTHROPIC_API_KEY secret is set in Firebase ===
// export { fallbackBrain } from "./bot/fallbackBrain";
