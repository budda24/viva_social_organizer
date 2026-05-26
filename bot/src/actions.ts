/**
 * Side-effecting actions the bot can take on behalf of a user.
 *
 * Claude proposes these by appending an `<<<ACTION ... ACTION>>>` marker to
 * its reply. The brain parses the marker, stores it as `pendingAction` on the
 * conversation state, and waits for the user to reply `yes`. When `yes` lands,
 * the brain dispatches to `executePendingAction` here — fully deterministic,
 * no Claude call on that turn.
 *
 * Two kinds for now:
 *   - `create_event`  — write events/{id}, auto-RSVP creator, broadcast to all
 *                       other approved members on their preferred channel.
 *   - `intro_buddy`   — enqueue an outbox row to one matched member with an
 *                       AI-drafted opener attributed to the source user.
 *
 * Channel routing: per recipient we prefer telegram (more reliable, no Twilio
 * sandbox join hassle), fall back to Twilio. Members with neither field set
 * are skipped silently; we count and report the skip in the creator-facing
 * confirmation.
 */

import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

const KIND_ENUM = [
  "breakfast",
  "coffee",
  "lunch",
  "drinks",
  "dinner",
  "rooftop",
  "walk",
  "side-event",
  "other",
] as const;
type EventKind = (typeof KIND_ENUM)[number];

export interface CreateEventAction {
  kind: "create_event";
  title: string;
  kind_enum: EventKind;
  startAtISO: string;
  addressNeighborhood?: string;
  addressFull?: string;
  capacity?: number;
  description?: string;
}

export interface IntroBuddyAction {
  kind: "intro_buddy";
  targetUid: string;
  opener: string;
}

export type PendingAction = CreateEventAction | IntroBuddyAction;

/**
 * Parse the trailing `<<<ACTION ... ACTION>>>` marker from a Claude reply.
 * Returns the stripped reply (what the user sees) plus the structured action,
 * or `{ reply, action: null }` if no marker is present or it's malformed.
 */
export function parseActionMarker(
  raw: string
): { reply: string; action: PendingAction | null } {
  const re = /<<<ACTION\s*([\s\S]+?)\s*ACTION>>>/;
  const m = raw.match(re);
  if (!m) return { reply: raw.trim(), action: null };

  const reply = raw.replace(re, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    // Marker present but JSON broken — drop the marker, ship the prose.
    return { reply, action: null };
  }
  const action = validateAction(parsed);
  return { reply, action };
}

function validateAction(raw: unknown): PendingAction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "create_event") {
    if (typeof o.title !== "string" || !o.title.trim()) return null;
    if (typeof o.startAtISO !== "string" || !o.startAtISO) return null;
    if (Number.isNaN(Date.parse(o.startAtISO))) return null;
    const kindEnum = (KIND_ENUM as readonly string[]).includes(o.kind_enum as string)
      ? (o.kind_enum as EventKind)
      : "other";
    return {
      kind: "create_event",
      title: String(o.title).slice(0, 60),
      kind_enum: kindEnum,
      startAtISO: String(o.startAtISO),
      addressNeighborhood:
        typeof o.addressNeighborhood === "string" ? o.addressNeighborhood : undefined,
      addressFull: typeof o.addressFull === "string" ? o.addressFull : undefined,
      capacity:
        typeof o.capacity === "number" && Number.isFinite(o.capacity)
          ? Math.max(1, Math.floor(o.capacity))
          : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
    };
  }
  if (o.kind === "intro_buddy") {
    if (typeof o.targetUid !== "string" || !o.targetUid.trim()) return null;
    if (typeof o.opener !== "string" || !o.opener.trim()) return null;
    return {
      kind: "intro_buddy",
      targetUid: String(o.targetUid),
      opener: String(o.opener).slice(0, 240),
    };
  }
  return null;
}

/** One-line summary of a pending action, for inclusion in Claude's context. */
export function describePendingAction(a: PendingAction): string {
  if (a.kind === "create_event") {
    const place = a.addressFull ? ` at ${a.addressFull}` : "";
    return `pending: create event "${a.title}" (${a.kind_enum})${place} at ${a.startAtISO} — awaiting yes`;
  }
  return `pending: intro to uid ${a.targetUid} — awaiting yes`;
}

type Provider = "twilio" | "telegram";

interface ChannelRoute {
  provider: Provider;
  phone?: string;
  chatId?: number;
}

function pickChannel(userData: Record<string, unknown>): ChannelRoute | null {
  const tg = userData.telegramChatId;
  if (typeof tg === "number" && Number.isFinite(tg)) {
    return { provider: "telegram", chatId: tg };
  }
  const phone = userData.whatsappPhoneE164;
  if (typeof phone === "string" && phone.startsWith("+")) {
    return { provider: "twilio", phone };
  }
  return null;
}

async function enqueueOutbox(
  db: Firestore,
  args: {
    recipientUid: string;
    route: ChannelRoute;
    body: string;
    type: string;
    eventId?: string;
    sourceUid?: string;
  }
): Promise<void> {
  const row: Record<string, unknown> = {
    recipientType: "individual",
    recipientUid: args.recipientUid,
    type: args.type,
    provider: args.route.provider,
    body: args.body,
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
    scheduledFor: Timestamp.now(),
  };
  if (args.route.provider === "twilio" && args.route.phone) {
    row.recipientPhone = args.route.phone;
  }
  if (args.route.provider === "telegram" && args.route.chatId !== undefined) {
    row.recipientChatId = args.route.chatId;
  }
  if (args.eventId) row.eventId = args.eventId;
  if (args.sourceUid) row.sourceUid = args.sourceUid;
  await db.collection("whatsappOutbox").add(row);
}

function formatEventAnnouncement(args: {
  hostName: string;
  title: string;
  kind: EventKind;
  startAtISO: string;
  addressNeighborhood?: string;
  addressFull?: string;
  description?: string;
}): string {
  const when = formatParisTime(args.startAtISO);
  const place =
    args.addressFull ??
    args.addressNeighborhood ??
    "(location TBC — RSVP for details)";
  const lines = [
    `${kindEmoji(args.kind)} ${args.title}`,
    `${when} · ${place}`,
    `Hosted by ${args.hostName}.`,
  ];
  if (args.description) lines.push(args.description);
  lines.push(`Reply "join ${args.title}" to RSVP.`);
  return lines.join("\n");
}

function kindEmoji(k: EventKind): string {
  switch (k) {
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

function formatParisTime(iso: string): string {
  // Format the start time as a short human string for Paris readers. The
  // Intl API will use the locale's 24h conventions for fr-FR.
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface ExecuteDeps {
  db: Firestore;
  uid: string;
  userData: Record<string, unknown>;
}

interface ExecuteResult {
  reply: string;
}

async function executeCreateEvent(
  deps: ExecuteDeps,
  action: CreateEventAction
): Promise<ExecuteResult> {
  const { db, uid, userData } = deps;
  const hostName = (userData.displayName as string | undefined) ?? "A member";

  const eventRef = db.collection("events").doc();
  const startAt = Timestamp.fromDate(new Date(action.startAtISO));
  await eventRef.set({
    title: action.title,
    kind: action.kind_enum,
    description: action.description ?? "",
    hostUid: uid,
    hostName,
    startAt,
    addressNeighborhood: action.addressNeighborhood ?? "",
    addressFull: action.addressFull ?? "",
    capacity: action.capacity ?? null,
    allowWaitlist: true,
    visibility: "all",
    status: "scheduled",
    source: "bot",
    createdAt: FieldValue.serverTimestamp(),
  });

  // Auto-RSVP the creator.
  await eventRef.collection("rsvps").doc(uid).set({
    uid,
    status: "going",
    via: "bot_create",
    at: FieldValue.serverTimestamp(),
  });

  // Broadcast to every other approved member.
  const announcement = formatEventAnnouncement({
    hostName,
    title: action.title,
    kind: action.kind_enum,
    startAtISO: action.startAtISO,
    addressNeighborhood: action.addressNeighborhood,
    addressFull: action.addressFull,
    description: action.description,
  });

  const members = await db
    .collection("users")
    .where("status", "==", "approved")
    .get();

  let pinged = 0;
  let skipped = 0;
  await Promise.all(
    members.docs.map(async (doc) => {
      if (doc.id === uid) return;
      const route = pickChannel(doc.data());
      if (!route) {
        skipped += 1;
        return;
      }
      await enqueueOutbox(db, {
        recipientUid: doc.id,
        route,
        body: announcement,
        type: "event_announce",
        eventId: eventRef.id,
        sourceUid: uid,
      });
      pinged += 1;
    })
  );

  const skipNote = skipped > 0 ? ` (${skipped} unreachable)` : "";
  return {
    reply: `✓ "${action.title}" created. Pinging ${pinged} members${skipNote}.`,
  };
}

async function executeIntroBuddy(
  deps: ExecuteDeps,
  action: IntroBuddyAction
): Promise<ExecuteResult> {
  const { db, uid, userData } = deps;
  const sourceName = (userData.displayName as string | undefined) ?? "A member";

  const targetSnap = await db.doc(`users/${action.targetUid}`).get();
  if (!targetSnap.exists) {
    return { reply: `Couldn't find that member. Try \`find me a buddy\` again.` };
  }
  const targetData = targetSnap.data() ?? {};
  if (targetData.status !== "approved") {
    return { reply: `That member isn't reachable right now.` };
  }
  const route = pickChannel(targetData);
  if (!route) {
    return {
      reply: `${targetData.displayName ?? "They"} hasn't linked WhatsApp or Telegram yet — can't ping.`,
    };
  }

  const introBody =
    `${sourceName} asked me to intro you.\n\n${action.opener}\n\n` +
    `Reply directly here to take it from there.`;

  await enqueueOutbox(db, {
    recipientUid: action.targetUid,
    route,
    body: introBody,
    type: "intro_ping",
    sourceUid: uid,
  });

  return { reply: `✓ Sent to ${targetData.displayName ?? "them"}.` };
}

export async function executePendingAction(
  deps: ExecuteDeps,
  action: PendingAction
): Promise<ExecuteResult> {
  if (action.kind === "create_event") return executeCreateEvent(deps, action);
  return executeIntroBuddy(deps, action);
}
