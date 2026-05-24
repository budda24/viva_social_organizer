import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";

initializeApp();
setGlobalOptions({ region: "europe-central2", maxInstances: 10 });

export { redeemInviteCode } from "./invites/redeem";
export { whapiWebhook } from "./bot/webhook";
export { fallbackBrain } from "./bot/fallbackBrain";
export { reclaimStaleInbox } from "./bot/reclaimInbox";
export { drainOutbox, onOutboxCreated } from "./messaging/outbox";
