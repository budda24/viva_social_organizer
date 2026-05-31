import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";

// Same bot token the outbox/webhook use. The bot must be an ADMIN of the
// supergroup below with the "Manage Topics" permission for createForumTopic.
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

// The single "Viva Tribe" forum supergroup. Telegram bots cannot create groups,
// only TOPICS inside a forum they admin — so we keep one supergroup (Topics
// enabled) and open a topic per event. chat id looks like -1001234567890.
const TELEGRAM_GROUP_CHAT_ID = defineString("TELEGRAM_GROUP_CHAT_ID", { default: "" });
// Public @username of that supergroup (without the @), if it's public — lets us
// deep-link straight to a topic: https://t.me/<username>/<threadId>. Leave empty
// for a private group; we then fall back to the invite link below.
const TELEGRAM_GROUP_USERNAME = defineString("TELEGRAM_GROUP_USERNAME", { default: "" });
// Static invite link to the supergroup, used when it has no public username.
const TELEGRAM_GROUP_INVITE = defineString("TELEGRAM_GROUP_INVITE", { default: "" });

const TOPIC_NAME_MAX = 128; // Telegram forum-topic name cap.

interface EventDoc {
  title?: unknown;
  kind?: unknown;
  hostName?: unknown;
  status?: unknown;
  startAt?: { toMillis?: () => number };
  addressNeighborhood?: unknown;
  addressFull?: unknown;
  telegramTopicId?: unknown;
}

// Minimal Telegram Bot API call. Throws on transport or API-level error so the
// caller can log + degrade gracefully (the event still exists without a topic).
async function tg(
  method: string,
  token: string,
  payload: Record<string, unknown>
): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: any };
  if (!res.ok || !json.ok) {
    throw new Error(`telegram ${method} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.result;
}

function kindEmoji(kind: string): string {
  switch (kind) {
    case "breakfast":
      return "🍳";
    case "coffee":
      return "☕";
    case "lunch":
      return "🥗";
    case "drinks":
      return "🥂";
    case "dinner":
      return "🍝";
    case "rooftop":
      return "🌇";
    case "walk":
      return "🚶";
    case "side-event":
      return "🎟️";
    default:
      return "📍";
  }
}

function tsMillis(v: { toMillis?: () => number } | undefined): number {
  return v && typeof v.toMillis === "function" ? v.toMillis() : 0;
}

function fmtWhen(startAt: EventDoc["startAt"]): string {
  const ms = tsMillis(startAt);
  if (!ms) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function topicName(e: EventDoc): string {
  return `${kindEmoji(String(e.kind ?? "other"))} ${String(e.title ?? "Event")}`.slice(
    0,
    TOPIC_NAME_MAX
  );
}

// Deep link to the topic. Public supergroup → t.me/<username>/<threadId> (works
// for non-members, who can join). Private → the invite link (no per-topic deep
// link exists for non-members, so they land in the group and pick the thread).
function topicLink(threadId: number): string {
  const username = TELEGRAM_GROUP_USERNAME.value().replace(/^@/, "").trim();
  if (username) return `https://t.me/${username}/${threadId}`;
  return TELEGRAM_GROUP_INVITE.value().trim();
}

// The discussion group is closed (only RSVP'd members get here), so the seed +
// update messages may carry the full address.
function placeOf(e: EventDoc): string {
  return String(e.addressFull || e.addressNeighborhood || "");
}

function seedMessage(e: EventDoc): string {
  const place = placeOf(e);
  return [
    `${kindEmoji(String(e.kind ?? "other"))} ${String(e.title ?? "")}`,
    [fmtWhen(e.startAt), place].filter(Boolean).join(" · "),
    e.hostName ? `Hosted by ${String(e.hostName)}.` : "",
    "Use this thread to coordinate — see you there!",
  ]
    .filter(Boolean)
    .join("\n");
}

function updateMessage(e: EventDoc): string {
  const place = placeOf(e);
  return [
    `🔄 Update — ${String(e.title ?? "")}`,
    [fmtWhen(e.startAt), place].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Reconcile a Telegram forum topic with each event's lifecycle.
 *
 * Fires on any write to events/{eventId} (NOT its rsvps subcollection, so RSVPs
 * don't trigger it). Idempotent:
 *   - created (scheduled, no topic) → createForumTopic, store telegramTopicId +
 *     telegramTopicLink, seed the thread with the event details.
 *   - title/time changed → rename the topic + post an update.
 *   - status → cancelled → post a cancellation note + close the topic (history
 *     kept; we don't delete).
 *
 * The bot's own write-back of telegramTopicId re-triggers this once and no-ops
 * (topic already exists, nothing else changed), so there's no loop.
 */
export const onEventWrite = onDocumentWritten(
  {
    document: "events/{eventId}",
    secrets: [TELEGRAM_BOT_TOKEN],
    region: "europe-central2",
  },
  async (event) => {
    const token = TELEGRAM_BOT_TOKEN.value();
    const groupChatId = TELEGRAM_GROUP_CHAT_ID.value().trim();
    // Not configured (no token or no supergroup) → feature off, no-op.
    if (!token || !groupChatId) return;

    const after = event.data?.after?.data() as EventDoc | undefined;
    if (!after) return; // hard-deleted; we soft-cancel, so nothing to reconcile.
    const before = event.data?.before?.data() as EventDoc | undefined;

    const eventId = event.params.eventId as string;
    const chatId = Number(groupChatId);
    const ref = getFirestore().doc(`events/${eventId}`);
    const existingTopic =
      typeof after.telegramTopicId === "number" ? after.telegramTopicId : undefined;

    // 1. New scheduled event without a topic → create one + seed it.
    if (after.status === "scheduled" && !existingTopic) {
      try {
        const result = await tg("createForumTopic", token, {
          chat_id: chatId,
          name: topicName(after),
        });
        const threadId: number | undefined = result?.message_thread_id;
        if (!threadId) throw new Error("createForumTopic returned no message_thread_id");
        await ref.set(
          { telegramTopicId: threadId, telegramTopicLink: topicLink(threadId) },
          { merge: true }
        );
        await tg("sendMessage", token, {
          chat_id: chatId,
          message_thread_id: threadId,
          text: seedMessage(after),
          disable_web_page_preview: true,
        }).catch((e) => console.warn(`[forum] seed message failed for ${eventId}: ${e}`));
      } catch (e) {
        console.error(`[forum] createForumTopic failed for ${eventId}: ${e}`);
      }
      return;
    }

    // Everything below needs an existing topic to act on.
    if (!existingTopic) return;

    // 2. Cancelled → post a note + close the topic (keep it for history).
    if (after.status === "cancelled" && before?.status !== "cancelled") {
      try {
        await tg("sendMessage", token, {
          chat_id: chatId,
          message_thread_id: existingTopic,
          text: "✕ This event has been cancelled by the host.",
        }).catch(() => undefined);
        await tg("closeForumTopic", token, {
          chat_id: chatId,
          message_thread_id: existingTopic,
        });
      } catch (e) {
        console.error(`[forum] close topic failed for ${eventId}: ${e}`);
      }
      return;
    }

    // 3. Title/time changed on a live event → rename + post the update.
    const titleChanged = !!before && before.title !== after.title;
    const timeChanged = !!before && tsMillis(before.startAt) !== tsMillis(after.startAt);
    if (after.status === "scheduled" && (titleChanged || timeChanged)) {
      try {
        if (titleChanged) {
          await tg("editForumTopic", token, {
            chat_id: chatId,
            message_thread_id: existingTopic,
            name: topicName(after),
          });
        }
        await tg("sendMessage", token, {
          chat_id: chatId,
          message_thread_id: existingTopic,
          text: updateMessage(after),
          disable_web_page_preview: true,
        }).catch(() => undefined);
      } catch (e) {
        console.error(`[forum] edit topic failed for ${eventId}: ${e}`);
      }
    }
  }
);
