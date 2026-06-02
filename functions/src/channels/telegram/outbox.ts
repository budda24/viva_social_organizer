import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

const MAX_ATTEMPTS = 3;
const MAX_BODY_CHARS = 4096; // Telegram hard limit per sendMessage.
const MAX_BTN_TEXT = 64; // Telegram button-label cap.
const MAX_BTN_DATA = 64; // Telegram callback_data cap (bytes).

interface OutboxButton {
  text?: unknown;
  data?: unknown;
}

/**
 * Build a Telegram inline keyboard from outbox `buttons`. Each becomes a
 * callback button whose `callback_data` is routed back through the webhook when
 * tapped. Laid out two-per-row. Returns null if there are no valid buttons (so
 * the caller omits reply_markup entirely).
 */
function buildInlineKeyboard(
  buttons: unknown
): Array<Array<{ text: string; callback_data: string }>> | null {
  if (!Array.isArray(buttons)) return null;
  const valid = (buttons as OutboxButton[])
    .filter(
      (b) =>
        b &&
        typeof b.text === "string" &&
        b.text.trim() &&
        typeof b.data === "string" &&
        b.data.trim()
    )
    .map((b) => ({
      text: String(b.text).slice(0, MAX_BTN_TEXT),
      callback_data: String(b.data).slice(0, MAX_BTN_DATA),
    }));
  if (valid.length === 0) return null;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < valid.length; i += 2) rows.push(valid.slice(i, i + 2));
  return rows;
}

/**
 * Clear the inline keyboard from a message (passing no reply_markup removes it).
 * Best-effort: Telegram replies 400 ("message is not modified" / "message to
 * edit not found") if it was already cleared, deleted, or never had a keyboard —
 * all harmless here, so callers ignore the throw.
 */
async function clearKeyboard(chatId: number | string, messageId: number, token: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

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

    const inlineKeyboard = buildInlineKeyboard(claimed.buttons);
    const token = TELEGRAM_BOT_TOKEN.value();

    // Keep only the latest ephemeral Yes/No keyboard tappable in this chat. A
    // confirmation answered by typing (not tapping) never hits the webhook's
    // tap-time clear, so its buttons linger and a later tap re-fires an action
    // that's already resolved. Before sending anything, wipe the previously
    // tracked ephemeral keyboard. Persistent keyboards (Join, Edit/Cancel,
    // Connect/Pass, language) are never tracked here, so they survive untouched.
    const kbStateRef = db.doc(`telegramKeyboardState/${chatId}`);
    const prevKbId = (await kbStateRef.get()).data()?.messageId as number | undefined;
    if (prevKbId) {
      await clearKeyboard(chatId, prevKbId, token).catch((e) =>
        console.warn(`[telegramOutbox] clear stale keyboard failed: ${e}`)
      );
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: body,
            disable_web_page_preview: true,
            ...(inlineKeyboard
              ? { reply_markup: { inline_keyboard: inlineKeyboard } }
              : {}),
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "<no body>");
        throw new Error(`telegram ${response.status}: ${errText.slice(0, 300)}`);
      }
      const result = (await response.json()) as { result?: { message_id?: number } };
      const providerMessageId = result.result?.message_id;

      // Track this message's keyboard only if it's an ephemeral Yes/No
      // confirmation, so the next outbound message clears it. Otherwise drop any
      // tracked id — the chat now has no pending ephemeral keyboard to clean up.
      if (claimed.ephemeralKeyboard && inlineKeyboard && providerMessageId) {
        await kbStateRef.set({ messageId: providerMessageId, updatedAt: FieldValue.serverTimestamp() });
      } else if (prevKbId) {
        await kbStateRef.delete().catch(() => {});
      }

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
