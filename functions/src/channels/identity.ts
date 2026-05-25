import { getFirestore } from "firebase-admin/firestore";
import type { ChannelId } from "./types";

export interface ResolvedUser {
  uid: string;
  status: string;
  displayName?: string;
}

/**
 * Map a channel-native identifier to an approved app user.
 *
 * Returns null when no user is found or the user isn't approved — callers
 * should ack the webhook with 200 and drop the message silently.
 */
export async function resolveUserByChannel(
  channel: ChannelId,
  channelUserId: string | number
): Promise<ResolvedUser | null> {
  const db = getFirestore();
  const field =
    channel === "twilio" ? "whatsappPhoneE164" : "telegramChatId";

  const snap = await db
    .collection("users")
    .where(field, "==", channelUserId)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  if (data.status !== "approved") return null;
  return {
    uid: doc.id,
    status: data.status,
    displayName: data.displayName,
  };
}
