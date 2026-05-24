/**
 * The actual Claude-driven reasoning per inbound message.
 * Stub implementation — fills in during Day 11–13 of the build (see plan §15).
 *
 * Plan for the real implementation:
 *  1. Load conversationStates/{phone} for short-term memory.
 *  2. Build a system prompt with the closed-vocabulary list and the user's profile.
 *  3. Use Anthropic tool-use (tools defined in ./tools.ts) so Claude can:
 *       readUser, readEvents, readRsvps, writeRsvp, writeFreeUntil,
 *       draftEvent, requestConfirmation, sendReply.
 *  4. Loop until Claude calls sendReply (or hits a max-turn cap).
 *  5. Persist conversation state update.
 *  6. The sendReply tool enqueues to whatsappOutbox.
 */

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type Anthropic from "@anthropic-ai/sdk";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

export interface ProcessMessageDeps {
  db: Firestore;
  anthropic: Anthropic;
  inboxDoc: QueryDocumentSnapshot;
  hostId: string;
}

export async function processMessage(deps: ProcessMessageDeps): Promise<void> {
  const { db, inboxDoc } = deps;
  const inbox = inboxDoc.data();
  const body = String(inbox.body ?? "").toLowerCase().trim();

  // Minimal placeholder routing for verification.
  // Replace with the full Claude tool-use loop in Day 11–13.
  let reply = "";
  let intent = "unknown";

  if (body === "stop") {
    intent = "stop";
    await db.doc(`users/${inbox.uid}`).update({ consentWhatsappMessages: false });
    reply = "Got it — you're off the WhatsApp list. Site access stays. Reply 'start' to opt back in.";
  } else if (body === "help" || body === "what can you do") {
    intent = "help";
    reply =
      "I can do: `free now` · `who is near me` · `find me <topic>` · `intro me to someone` · " +
      "`breakfast tomorrow` · `beer tonight` · `join <event>` · `stop`. " +
      "I'm narrow on purpose — say one of these.";
  } else {
    reply =
      "I only do a small set of things — try `help` to see them. " +
      "For the full experience, open app.foundersatviva.com.";
  }

  await db.collection("whatsappOutbox").add({
    recipientType: "individual",
    recipientPhone: inbox.phone,
    recipientUid: inbox.uid,
    type: "bot_reply",
    body: reply,
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
    scheduledFor: Timestamp.now(),
  });

  await inboxDoc.ref.update({ intent });
}
