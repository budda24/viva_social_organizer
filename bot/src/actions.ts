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
import { msg, normalizeLang, type Lang } from "./i18n.js";

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

// A Telegram inline-keyboard CTA button. `text` is the (localized) label the
// user sees; `data` is the canonical token routed back through the inbox when
// tapped (e.g. "yes", "no", "join <eventId>"). Telegram-only — the Twilio
// transport ignores it and keeps the text CTA in the body.
export interface OutboxButton {
  text: string;
  data: string;
}

// Stored on conversationStates/{recipientUid}.pendingIntroRequest while a
// double-opt-in intro is awaiting the recipient's yes/no. The recipient must
// accept before either party's contact is shared.
export interface PendingIntroRequest {
  requestId: string;
  fromUid: string;
  fromName: string;
}

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
    // Build with only the keys that are present — Firestore rejects `undefined`
    // values when this action is persisted as a pendingAction, so absent
    // optionals must be omitted rather than set to undefined.
    const action: CreateEventAction = {
      kind: "create_event",
      title: String(o.title).slice(0, 60),
      kind_enum: kindEnum,
      startAtISO: String(o.startAtISO),
    };
    if (typeof o.addressNeighborhood === "string") {
      action.addressNeighborhood = o.addressNeighborhood;
    }
    if (typeof o.addressFull === "string") action.addressFull = o.addressFull;
    if (typeof o.capacity === "number" && Number.isFinite(o.capacity)) {
      action.capacity = Math.max(1, Math.floor(o.capacity));
    }
    if (typeof o.description === "string") action.description = o.description;
    return action;
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
    // Telegram-only: tap-buttons + the body to show in their place (the `body`
    // above stays the WhatsApp/fallback text, with its inline "Reply …" CTA).
    buttons?: OutboxButton[];
    telegramBody?: string;
  }
): Promise<void> {
  const isTelegram = args.route.provider === "telegram";
  const body =
    isTelegram && args.telegramBody !== undefined ? args.telegramBody : args.body;
  const row: Record<string, unknown> = {
    recipientType: "individual",
    recipientUid: args.recipientUid,
    type: args.type,
    provider: args.route.provider,
    body,
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
  if (isTelegram && args.buttons && args.buttons.length > 0) {
    row.buttons = args.buttons;
  }
  if (args.eventId) row.eventId = args.eventId;
  if (args.sourceUid) row.sourceUid = args.sourceUid;
  await db.collection("whatsappOutbox").add(row);
}

// Build the broadcast in a specific recipient's language. The bot announces
// the same event to everyone, but each person reads it in their own language.
function formatEventAnnouncement(
  lang: Lang,
  args: {
    hostName: string;
    title: string;
    kind: EventKind;
    startAtISO: string;
    addressNeighborhood?: string;
    addressFull?: string;
    description?: string;
  },
  withCta = true
): string {
  const when = formatParisTime(args.startAtISO, lang);
  const place =
    args.addressFull ??
    args.addressNeighborhood ??
    (lang === "fr" ? "(lieu à confirmer)" : "(location TBC)");
  return msg(lang).eventAnnounce(
    {
      emoji: kindEmoji(args.kind),
      title: args.title,
      when,
      place,
      hostName: args.hostName,
      description: args.description,
    },
    withCta
  );
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

function formatParisTime(iso: string, lang: Lang = "en"): string {
  try {
    return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
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
  lang: Lang;
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

  // Broadcast to every other approved member, each in their own language.
  const members = await db
    .collection("users")
    .where("status", "==", "approved")
    .get();

  let pinged = 0;
  let skipped = 0;
  await Promise.all(
    members.docs.map(async (doc) => {
      if (doc.id === uid) return;
      const data = doc.data();
      const route = pickChannel(data);
      if (!route) {
        skipped += 1;
        return;
      }
      const recipientLang = normalizeLang(data.preferredLanguage);
      const announceArgs = {
        hostName,
        title: action.title,
        kind: action.kind_enum,
        startAtISO: action.startAtISO,
        addressNeighborhood: action.addressNeighborhood,
        addressFull: action.addressFull,
        description: action.description,
      };
      await enqueueOutbox(db, {
        recipientUid: doc.id,
        route,
        body: formatEventAnnouncement(recipientLang, announceArgs, true),
        // On Telegram the Join button replaces the "Reply join …" text line.
        telegramBody: formatEventAnnouncement(recipientLang, announceArgs, false),
        buttons: [
          { text: msg(recipientLang).btn.join, data: `join ${eventRef.id}` },
        ],
        type: "event_announce",
        eventId: eventRef.id,
        sourceUid: uid,
      });
      pinged += 1;
    })
  );

  return {
    reply: msg(deps.lang).eventCreated(action.title, pinged, skipped),
  };
}

// A one-line "who's asking" descriptor auto-pulled from the requester's profile
// (no extra turn asked of them), so the recipient can decide with context: their
// bio + what they're at VivaTech to do (goal). The model-drafted opener carries
// the specific "why this person"; this line carries the durable who/what.
function bioLine(userData: Record<string, unknown>): string {
  const enr = (userData.enrichment ?? {}) as Record<string, unknown>;
  const bio = ((enr.bio as string) || (userData.bio as string) || "").trim();
  const goal = ((userData.goal as string) || "").trim();
  const parts: string[] = [];
  if (bio) parts.push(bio.slice(0, 90));
  if (goal) parts.push(`here to ${goal}`);
  return parts.join(" · ").slice(0, 160);
}

// The requester's public LinkedIn URL, so the buddy can vet them before
// accepting. Sourced from the enrichment worker (which web-searches it) — only
// present when enrichment confidently identified the person.
function linkedinUrlOf(userData: Record<string, unknown>): string | undefined {
  const enr = (userData.enrichment ?? {}) as Record<string, unknown>;
  const url = (enr.linkedinUrl as string) || (userData.linkedinUrl as string);
  return url && url.trim() ? url.trim() : undefined;
}

// A shareable contact handle. Telegram usernames (t.me links) are designed to
// be shared; WhatsApp uses wa.me/<digits>. Returns empty label if the user has
// no shareable handle (e.g. Telegram without a username) — caller falls back to
// just the name.
function contactHandle(
  userData: Record<string, unknown>
): { label: string; link?: string } {
  const username = userData.telegramUsername;
  if (typeof username === "string" && username.trim()) {
    const u = username.replace(/^@/, "");
    return { label: `@${u}`, link: `https://t.me/${u}` };
  }
  const phone = userData.whatsappPhoneE164;
  if (typeof phone === "string" && phone.startsWith("+")) {
    const digits = phone.replace(/[^0-9]/g, "");
    return { label: phone, link: `https://wa.me/${digits}` };
  }
  return { label: "" };
}

function contactText(
  lang: Lang,
  name: string,
  handle: { label: string; link?: string },
  linkedinUrl?: string
): string {
  // VivaTech is a professional event — LinkedIn is the natural "let's connect
  // and catch up" handle, so swap it alongside the messaging handle when we
  // have it. The handle lets them coordinate the actual meetup; LinkedIn lets
  // them connect properly. Fall back to LinkedIn-only, then the no-handle line.
  const li = linkedinUrl ? ` · LinkedIn: ${linkedinUrl}` : "";
  if (handle.link) return `${name} → ${handle.link}${li}`;
  if (handle.label) return `${name} → ${handle.label}${li}`;
  if (linkedinUrl) return `${name} → LinkedIn: ${linkedinUrl}`;
  return msg(lang).contactReachesOut(name);
}

// Step 1 of the double-opt-in intro. The requester (A) confirmed `yes` on a
// match; we DON'T share contacts yet — we send the buddy (B) a request they
// must accept. Writes introRequests/{id} and parks a pendingIntroRequest on
// B's conversation state so their next yes/no resolves it (in brain.ts).
async function executeIntroBuddy(
  deps: ExecuteDeps,
  action: IntroBuddyAction
): Promise<ExecuteResult> {
  const { db, uid, userData } = deps;
  const sourceName = (userData.displayName as string | undefined) ?? "A member";

  if (action.targetUid === uid) {
    return { reply: `That one's you 🙂 — try \`find me a buddy\` for someone else.` };
  }

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
      reply: `${targetData.displayName ?? "They"} hasn't linked WhatsApp or Telegram yet — can't reach them.`,
    };
  }
  const targetName = (targetData.displayName as string | undefined) ?? "there";

  // Record the pending request.
  const reqRef = db.collection("introRequests").doc();
  await reqRef.set({
    fromUid: uid,
    fromName: sourceName,
    toUid: action.targetUid,
    toName: targetName,
    opener: action.opener,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });

  // Park the consent prompt on B's conversation state (resolved by brain.ts).
  await db.doc(`conversationStates/${action.targetUid}`).set(
    {
      uid: action.targetUid,
      pendingIntroRequest: {
        requestId: reqRef.id,
        fromUid: uid,
        fromName: sourceName,
      },
      pendingIntroRequestAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // The request goes to B, so it's in B's language; the confirmation goes
  // back to A (the requester), so it's in A's language (deps.lang). Include
  // A's LinkedIn URL so B can vet them before accepting.
  const recipientLang = normalizeLang(targetData.preferredLanguage);
  const fromBio = bioLine(userData);
  const fromLinkedin = linkedinUrlOf(userData);
  const requestBody = msg(recipientLang).introRequest(
    sourceName,
    fromBio,
    action.opener,
    fromLinkedin
  );

  await enqueueOutbox(db, {
    recipientUid: action.targetUid,
    route,
    body: requestBody,
    // On Telegram, Connect/Pass buttons replace the "Reply yes/no" line; the
    // tapped token is still yes/no so brain.ts's intro-request handler resolves
    // it unchanged.
    telegramBody: msg(recipientLang).introRequest(
      sourceName,
      fromBio,
      action.opener,
      fromLinkedin,
      false
    ),
    buttons: [
      { text: msg(recipientLang).btn.connect, data: "yes" },
      { text: msg(recipientLang).btn.pass, data: "no" },
    ],
    type: "intro_request",
    sourceUid: uid,
  });

  return { reply: msg(deps.lang).introSent(targetName) };
}

// Step 2a — the buddy (B, = deps.uid) accepted. Share contacts both ways.
export async function acceptIntroRequest(
  deps: ExecuteDeps,
  req: PendingIntroRequest
): Promise<ExecuteResult> {
  const { db, uid, userData } = deps;
  const accepterName = (userData.displayName as string | undefined) ?? "They";

  await db.doc(`introRequests/${req.requestId}`).set(
    { status: "accepted", respondedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  const fromSnap = await db.doc(`users/${req.fromUid}`).get();
  if (!fromSnap.exists) {
    return { reply: msg(deps.lang).introRequestExpired };
  }
  const fromData = fromSnap.data() ?? {};
  const fromName = (fromData.displayName as string | undefined) ?? req.fromName ?? "They";
  const fromLang = normalizeLang(fromData.preferredLanguage);

  const accepterHandle = contactHandle(userData);
  const fromHandle = contactHandle(fromData);
  // Full contact swap on accept: each side gets the other's LinkedIn too, so
  // they can connect and catch up — not just the messaging handle.
  const accepterLinkedin = linkedinUrlOf(userData);
  const fromLinkedin = linkedinUrlOf(fromData);

  // Tell the requester (A) it was accepted, with B's contact — in A's language.
  const fromRoute = pickChannel(fromData);
  if (fromRoute) {
    await enqueueOutbox(db, {
      recipientUid: req.fromUid,
      route: fromRoute,
      body: msg(fromLang).introAccepted(
        accepterName,
        contactText(fromLang, accepterName, accepterHandle, accepterLinkedin)
      ),
      type: "intro_accepted",
      sourceUid: uid,
    });
  }

  // Reply to the accepter (B) with A's contact — in B's language (deps.lang).
  return {
    reply: msg(deps.lang).introConnected(
      fromName,
      contactText(deps.lang, fromName, fromHandle, fromLinkedin)
    ),
  };
}

// Step 2b — the buddy (B) declined. Notify A gently; share nothing.
export async function declineIntroRequest(
  deps: ExecuteDeps,
  req: PendingIntroRequest
): Promise<ExecuteResult> {
  const { db, uid } = deps;

  await db.doc(`introRequests/${req.requestId}`).set(
    { status: "declined", respondedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  const fromSnap = await db.doc(`users/${req.fromUid}`).get();
  if (fromSnap.exists) {
    const fromData = fromSnap.data() ?? {};
    const fromRoute = pickChannel(fromData);
    if (fromRoute) {
      await enqueueOutbox(db, {
        recipientUid: req.fromUid,
        route: fromRoute,
        body: msg(normalizeLang(fromData.preferredLanguage)).introDeclined,
        type: "intro_declined",
        sourceUid: uid,
      });
    }
  }

  return { reply: msg(deps.lang).introPassed };
}

export async function executePendingAction(
  deps: ExecuteDeps,
  action: PendingAction
): Promise<ExecuteResult> {
  if (action.kind === "create_event") return executeCreateEvent(deps, action);
  return executeIntroBuddy(deps, action);
}
