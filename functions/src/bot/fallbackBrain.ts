import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const BACKLOG_TRIGGER_MS = 30_000;

/**
 * Degraded-mode brain. Fires when a botInbox row is created.
 * Only takes over if the laptop hasn't claimed the message within BACKLOG_TRIGGER_MS
 * AND system/config.useFallbackBrain == true.
 *
 * Covers read-only verbs (stop, help, who is near me, find me X).
 * Anything that would mutate other members' data is deferred for the laptop.
 */
export const fallbackBrain = onDocumentCreated(
  {
    document: "botInbox/{id}",
    secrets: [ANTHROPIC_API_KEY],
    region: "europe-central2",
  },
  async (event) => {
    const inboxRef = event.data?.ref;
    if (!inboxRef) return;

    const db = getFirestore();
    const cfgSnap = await db.doc("system/config").get();
    const cfg = cfgSnap.data() ?? {};
    if (!cfg.useFallbackBrain) return;

    // Wait for the laptop to claim the message before stepping in.
    await new Promise((r) => setTimeout(r, BACKLOG_TRIGGER_MS));

    const fresh = await inboxRef.get();
    const data = fresh.data();
    if (!data || data.status !== "pending") return;

    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(inboxRef);
      const d = snap.data();
      if (!d || d.status !== "pending") return null;
      tx.update(inboxRef, {
        status: "processing",
        leasedBy: "fallback-cloud",
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000),
        attempts: FieldValue.increment(1),
      });
      return d;
    });
    if (!claimed) return;

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const result = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        system:
          "You are a fallback handler for the Founders & Builders @ VivaTech bot. " +
          "The full assistant is temporarily offline. Respond in <=200 chars, warmly, " +
          "and ONLY for these intents: stop (opt out), help (list commands), " +
          'who_near_me (say "checking — back in a sec"), find_me (same). ' +
          "For anything else, reply: 'The assistant is briefly offline — try again in a minute, " +
          "or use the website at app.foundersatviva.com.'",
        messages: [{ role: "user", content: claimed.body }],
      });
      const reply =
        result.content[0]?.type === "text"
          ? result.content[0].text
          : "Try again in a moment.";

      await db.collection("whatsappOutbox").add({
        recipientType: "individual",
        recipientPhone: claimed.phone,
        recipientUid: claimed.uid,
        type: "bot_reply",
        body: reply,
        status: "queued",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
        scheduledFor: Timestamp.now(),
      });

      await inboxRef.update({
        status: "done",
        completedAt: FieldValue.serverTimestamp(),
        intent: "fallback",
      });
    } catch (e: any) {
      await inboxRef.update({
        status: "failed",
        lastError: String(e?.message ?? e),
      });
    }
  }
);
