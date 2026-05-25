/**
 * Shared types for channel adapters (Twilio WhatsApp, Telegram, ...).
 *
 * The bot brain treats inbound messages and outbound replies uniformly. The
 * `provider` field on each Firestore row is the dispatch key telling each
 * adapter whether to process or skip.
 */

export type ChannelId = "twilio" | "telegram";

export interface InboxRow {
  messageId: string;
  provider: ChannelId;
  uid: string;
  body: string;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  // Channel-specific identifiers — exactly one set is populated per row.
  phone?: string;           // twilio
  profileName?: string;     // twilio
  chatId?: number;          // telegram
  tgUsername?: string;      // telegram
}

export interface OutboxRow {
  provider: ChannelId;
  recipientUid: string;
  body: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  type?: string;
  // Channel-specific recipient — exactly one set per row.
  recipientPhone?: string;  // twilio
  recipientChatId?: number; // telegram
}
