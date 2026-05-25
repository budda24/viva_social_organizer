import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

const MAX_ATTEMPTS = 3;
const MAX_BODY_CHARS = 4096; // Telegram hard limit per sendMessage.

/**
 * Send outbox rows tagged provider=telegram via the Telegram Bot API.
 * Fires on creation of whatsappOutbox/{messageId} rows. Mirrors the Twilio
 * outbox listener — same row schema, different transport.
 *
 * Telegram has no template/24h-window concept; any text to a known chat_id
 * works. There is no per-message cost.
 */
export const onTelegramOutboxCreated = onDocumentCreated(
  {
    document: "whatsappOutbox/{messageId}",
    secrets: [TELEGRAM_BOT_TOKEN],
    region: "europe-central2",
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.provider !== "telegram") return;
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

    const chatId = claimed.recipientChatId;
    const body = String(claimed.body ?? "").slice(0, MAX_BODY_CHARS);

    if (!chatId || !body) {
      await ref.update({
        status: "failed",
        lastError: "missing recipientChatId or empty body",
      });
      return;
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: body,
            disable_web_page_preview: true,
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "<no body>");
        throw new Error(`telegram ${response.status}: ${errText.slice(0, 300)}`);
      }
      const result = (await response.json()) as { result?: { message_id?: number } };
      const providerMessageId = result.result?.message_id;

      await ref.update({
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageSid: providerMessageId ? String(providerMessageId) : null,
      });

      await db.doc(`whatsappLog/${event.params.messageId}`).set({
        ...claimed,
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageSid: providerMessageId ? String(providerMessageId) : null,
      });
    } catch (e: any) {
      const attempts = (claimed.attempts ?? 0) + 1;
      const final = attempts >= MAX_ATTEMPTS;
      const message = e?.message ?? String(e);
      console.error(`[telegramOutbox] send failed (attempt ${attempts}): ${message}`);
      await ref.update({
        status: final ? "failed" : "queued",
        lastError: message,
      });
    }
  }
);
