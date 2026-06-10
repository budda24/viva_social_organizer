/**
 * Bot brain — calls the Claude Agent SDK in-process per inbound message and
 * pipes the reply into whatsappOutbox.
 *
 * Was previously a `claude -p` subprocess spawn; the swap removes the ~2-3s
 * per-message cold start and runs natively async. CLAUDE.md is loaded once at
 * module init and passed as systemPrompt (Agent SDK doesn't auto-load it the
 * way the CLI does in cwd).
 *
 * Auth: Agent SDK reads ANTHROPIC_API_KEY if set; otherwise falls back to the
 * Claude Code OAuth session in ~/.claude/. Subscription auth works for the
 * prototype; switch to API key + prompt caching for real multi-user load.
 *
 * Channel-aware: reads `provider` from the inbox row and writes outbox rows
 * with the right recipient field (recipientPhone for twilio, recipientChatId
 * for telegram). Conversation history is keyed by uid so the same person
 * carries context across channels.
 */

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { runChat, embed } from "./llm.js";
import { transcribeTelegramVoice } from "./voice.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dedupeTopics,
  MAX_TOPICS,
  parseTopics,
  runOnboardingStep,
  type UserDocLike,
} from "./onboarding.js";
import {
  acceptIntroRequest,
  declineIntroRequest,
  describePendingAction,
  executePendingAction,
  contactHandle,
  contactText,
  linkedinUrlOf,
  isEventOngoing,
  isLockedForChanges,
  ONGOING_WINDOW_MS,
  parseActionMarker,
  type OutboxButton,
  type PendingAction,
  type PendingIntroRequest,
} from "./actions.js";
import { createTribeForHost, resolveOtOwner } from "./online-tribes.js";
import {
  claudeLanguageDirective,
  isAffirmative,
  isConnectWord,
  isNegative,
  isPassWord,
  languageName,
  msg,
  normalizeLang,
  parseLangReply,
  parseLanguageCommand,
  type Lang,
} from "./i18n.js";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE_MD_PATH = path.join(BOT_DIR, "CLAUDE.md");
const MAX_REPLY_CHARS = 1200;
const HISTORY_LIMIT = 6;

// Read once at module load — system prompt rarely changes mid-process.
const BASE_SYSTEM_PROMPT = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");

type Provider = "twilio" | "telegram";

export interface ProcessMessageDeps {
  db: Firestore;
  inboxDoc: QueryDocumentSnapshot;
  hostId: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  at: Timestamp;
}

interface EventCreationState {
  step: "awaiting_description";
  startedAt: Timestamp;
  // How many times we've re-asked for a usable description. Caps the loop so a
  // non-event reply can't keep the user stuck on "give me the details".
  tries?: number;
}

// Owner has run `edit event <title>` and we're waiting for them to describe the
// change. The next free-text turn is routed to Claude in EDIT_EVENT_MODE with
// this eventId as the authoritative target.
interface EditEventState {
  step: "awaiting_changes";
  eventId: string;
  startedAt: Timestamp;
}

// Host just created an event and we're waiting for their Online Tribes username
// to spin up the group tribe (carries the event id to attach the link to).
interface AwaitingOtUsernameState {
  eventId: string;
  startedAt: Timestamp;
  attempts?: number;
  // A handle the host gave that we've echoed back for confirmation but not yet
  // used — guards against a mistyped/garbage handle silently creating a tribe
  // owned by a stranger whose username happens to match.
  pendingUsername?: string;
}

interface ConvoState {
  turns?: Turn[];
  pendingAction?: PendingAction;
  pendingActionAt?: Timestamp;
  eventCreation?: EventCreationState;
  editEvent?: EditEventState;
  awaitingOtUsername?: AwaitingOtUsernameState;
  pendingIntroRequest?: PendingIntroRequest;
  awaitingLanguage?: boolean;
}

async function setAwaitingLanguage(
  db: Firestore,
  uid: string,
  awaiting: boolean
): Promise<void> {
  await db.doc(`conversationStates/${uid}`).set(
    {
      uid,
      awaitingLanguage: awaiting ? true : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function setPreferredLanguage(
  db: Firestore,
  uid: string,
  lang: Lang
): Promise<void> {
  await db.doc(`users/${uid}`).set({ preferredLanguage: lang }, { merge: true });
}

async function clearPendingIntroRequest(
  db: Firestore,
  uid: string
): Promise<void> {
  await db.doc(`conversationStates/${uid}`).set(
    {
      uid,
      pendingIntroRequest: FieldValue.delete(),
      pendingIntroRequestAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function loadConvoState(db: Firestore, uid: string): Promise<ConvoState> {
  const snap = await db.doc(`conversationStates/${uid}`).get();
  return (snap.data() as ConvoState | undefined) ?? {};
}

async function loadConversation(db: Firestore, uid: string): Promise<Turn[]> {
  const state = await loadConvoState(db, uid);
  return (state.turns ?? []).slice(-HISTORY_LIMIT);
}

async function setPendingAction(
  db: Firestore,
  uid: string,
  action: PendingAction | null
): Promise<void> {
  const ref = db.doc(`conversationStates/${uid}`);
  if (action) {
    await ref.set(
      {
        uid,
        pendingAction: action,
        pendingActionAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set(
      {
        uid,
        pendingAction: FieldValue.delete(),
        pendingActionAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
}

// Lenient on purpose: these only gate the yes/no fast-paths, where a
// confirmation prompt is already outstanding. Accepting "yes create it" /
// "ok do it" here keeps the pending action from falling through to Claude
// (which would re-propose it and re-show the Yes/No buttons).
const isYes = isAffirmative;
const isNo = isNegative;

// `create event`, `/event`, `new event`, `add event` (+ French: `créer
// événement`, `nouvel événement`, `événement`), optionally with an inline
// description. The optional rest is parsed as the description in the same turn.
//
// Plain English `event …` without create/new/add OR a leading slash is
// rejected so "the event went well" doesn't trigger the wizard.
const CREATE_EVENT_CMD_RE =
  /^\s*(?:\/[\w-]*event|(?:create|new|add|start|make)[\s_-]+(?:a\s+|an\s+|a\s+new\s+|another\s+)?event|(?:cr[ée]er|nouvel|nouvelle|ajouter)[\s_-]+(?:un\s+|une\s+)?[ée]v[ée]nement|[ée]v[ée]nement)\b[:\s-]*(.*)$/i;

function matchCreateEventCommand(text: string): { matched: boolean; rest: string } {
  const m = text.match(CREATE_EVENT_CMD_RE);
  if (!m) return { matched: false, rest: "" };
  return { matched: true, rest: m[1].trim() };
}

async function setEventCreation(
  db: Firestore,
  uid: string,
  step: "awaiting_description" | null,
  tries = 0
): Promise<void> {
  const ref = db.doc(`conversationStates/${uid}`);
  if (step) {
    await ref.set(
      {
        uid,
        eventCreation: {
          step,
          startedAt: Timestamp.now(),
          tries,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set(
      {
        uid,
        eventCreation: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
}

async function setEditEvent(
  db: Firestore,
  uid: string,
  eventId: string | null
): Promise<void> {
  const ref = db.doc(`conversationStates/${uid}`);
  if (eventId) {
    await ref.set(
      {
        uid,
        editEvent: { step: "awaiting_changes", eventId, startedAt: Timestamp.now() },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set(
      { uid, editEvent: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
}

// Pull an Online Tribes username out of a reply to the "what's your OT username?"
// prompt. Accepts bare handles and natural phrasings ("my username is X",
// "it's @X", "mon pseudo est X"). Returns null when the message clearly isn't a
// username answer (a question, command, or multi-word sentence) — the caller
// uses that to STOP trapping the host on the username step.
function extractOtUsername(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(
    /^(?:my\s+(?:ot\s+|online[\s-]?tribes?\s+)?username\s+is|username\s*[:=]?\s*(?:is\s+)?|here\s+(?:it\s+)?is|it'?s|it\s+is|c'?est|mon\s+pseudo\s+(?:est|c'?est)?|pseudo\s*[:=]?)\s*/i,
    ""
  );
  s = s.replace(/^@/, "").trim();
  // A username is a single handle-safe token. Spaces / sentence punctuation ⇒
  // it isn't a username answer.
  return /^[A-Za-z0-9_.\-]{2,40}$/.test(s) ? s : null;
}

async function setAwaitingOtUsername(
  db: Firestore,
  uid: string,
  eventId: string | null
): Promise<void> {
  const ref = db.doc(`conversationStates/${uid}`);
  if (eventId) {
    await ref.set(
      {
        uid,
        awaitingOtUsername: { eventId, startedAt: Timestamp.now() },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set(
      { uid, awaitingOtUsername: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
}

// `free now`, `free`, `free for 30`, `free for 1h`, `free for 90m`, plus the
// French equivalents `libre`, `dispo`, `disponible` (+ same duration tail).
// Returns the availability window in minutes (default 60). Doesn't match
// "free advice?" / unrelated text — requires bare/now/for-number form.
const FREE_CMD_RE =
  /^\s*(?:free|libre|dispo|disponible)(?:\s+now|\s+(?:for|pour|pendant)\b.*|\s*)$/i;

function parseFreeCommand(text: string): { matched: boolean; minutes: number } {
  const t = text.trim().toLowerCase();
  if (!FREE_CMD_RE.test(t)) return { matched: false, minutes: 0 };
  let minutes = 60; // "free" / "free now" → default 1 hour
  const num = t.match(/(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)?/);
  if (num) {
    const n = parseInt(num[1], 10);
    const unit = num[2] ?? "m";
    minutes = /^h/.test(unit) ? n * 60 : n;
  }
  minutes = Math.max(5, Math.min(minutes, 720)); // clamp 5min–12h
  return { matched: true, minutes };
}

// Paris calendar day as a sortable "YYYY-MM-DD" key. Comparing two of these
// lexicographically tells us whether an event lands on (or before) today in
// Paris — used to enforce the "no same-day events" rule.
function parisDateKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function formatParisHHMM(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

// Full date + time in Paris, localized — used in the RSVP confirmation so the
// attendee knows exactly when (the public listing already showed roughly when).
function formatParisDateTime(ms: number, lang: Lang = "en"): string {
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export interface DirectoryMember {
  uid: string;
  name: string;
  // Asked from the user during onboarding:
  goal: string;
  energy: string;
  // Filled by async enrichment worker:
  enrichedBio: string;
  enrichedTopics: string[];
  enrichedCompany: string;
  enrichedRecentActivity: string;
  enrichedMatchSignals: string;
  // Legacy / seed-data fields (kept for backward compat with test users):
  bio: string;
  topics: string[];
  lookingFor: string;
  city: string;
  // Spontaneous availability — epoch ms of their freeUntil, if in the future.
  freeUntilMs?: number;
}

export async function loadMemberDirectory(db: Firestore): Promise<DirectoryMember[]> {
  const snap = await db.collection("users").where("status", "==", "approved").get();
  return snap.docs
    // Drop load-test artifacts (`lt-…` users tagged isLoadTest) — they're pure
    // throughput fixtures and must never surface as real match suggestions
    // (e.g. "LoadTest 10" being offered for "find me a climate VC").
    .filter((d) => d.data().isLoadTest !== true)
    // Only members who've actually JOINED the bot (have a Telegram or WhatsApp
    // binding) can be pinged/intro'd — recommending an un-reachable web-only
    // signup is a dead end (Shah, Jun 9: "user hasn't joined the bot, how does it
    // recommend as a buddy?"). Filter them out of every match + who-is-here.
    .filter((d) => {
      const u = d.data();
      return u.telegramChatId != null || u.whatsappPhoneE164 != null;
    })
    .map((d) => {
      const u = d.data();
      const enr = (u.enrichment ?? {}) as Record<string, unknown>;
      return {
        uid: d.id,
        name: String(u.displayName ?? ""),
        goal: String(u.goal ?? ""),
        energy: String(u.energy ?? ""),
        enrichedBio: String(enr.bio ?? ""),
        enrichedTopics: Array.isArray(enr.topics) ? (enr.topics as string[]) : [],
        enrichedCompany: String(enr.company ?? ""),
        enrichedRecentActivity: String(enr.recentActivity ?? ""),
        enrichedMatchSignals: String(enr.matchSignals ?? ""),
        bio: String(u.bio ?? ""),
        topics: Array.isArray(u.topics) ? (u.topics as string[]) : [],
        lookingFor: String(u.lookingFor ?? ""),
        city: String(u.city ?? ""),
        // Future-only — filter expired here so the cached block stays stable
        // (Claude double-checks against the current-time line for the 30s
        // staleness window).
        freeUntilMs:
          u.freeUntil &&
          typeof u.freeUntil.toMillis === "function" &&
          u.freeUntil.toMillis() > Date.now()
            ? (u.freeUntil.toMillis() as number)
            : undefined,
      };
    })
    .sort((a, b) => a.uid.localeCompare(b.uid)); // stable order → byte-identical block → cacheable
}

// In-process directory cache. The directory is identical for every user and
// changes slowly (new members, enrichment), so reading the whole users
// collection on every message is pure waste — it was the throughput ceiling at
// 1000-member scale (~1 read per member per message). Serve a cached snapshot
// and refresh on a timer; stale-while-revalidate so messages never block on the
// reload, and single-flight so a burst triggers one Firestore read, not N.
const DIRECTORY_TTL_MS = Number(process.env.DIRECTORY_TTL_MS ?? 30_000);
let directoryCache: { members: DirectoryMember[]; loadedAt: number } | null = null;
let directoryInflight: Promise<DirectoryMember[]> | null = null;

async function getMemberDirectory(db: Firestore): Promise<DirectoryMember[]> {
  const isFresh =
    directoryCache !== null && Date.now() - directoryCache.loadedAt < DIRECTORY_TTL_MS;

  if (!isFresh && directoryInflight === null) {
    directoryInflight = loadMemberDirectory(db)
      .then(async (members) => {
        // Embed (new/changed) members here, inside the single-flight load, so a
        // burst of messages triggers one batched embed pass — not one per message.
        await ensureMemberEmbeddings(members);
        directoryCache = { members, loadedAt: Date.now() };
        return members;
      })
      .finally(() => {
        directoryInflight = null;
      });
    // We have stale data to serve below, so don't let a background refresh
    // failure surface as an unhandled rejection — we just keep the stale copy.
    if (directoryCache !== null) directoryInflight.catch(() => {});
  }

  if (directoryCache !== null) return directoryCache.members; // fresh or stale-while-revalidate
  return directoryInflight!; // first ever load — wait for it (errors propagate to caller)
}

// Recognized intents that must be answered even mid-onboarding, so a real
// question isn't swallowed as a profile answer. Kept deliberately specific:
// a plain onboarding answer (e.g. a topics list "AI, climate, fintech", or
// "I build communities") must NOT match — only clear commands, or a venture
// mention paired with a question cue.
const VENTURE_RE = /\b(omnia|online tribes?)\b/i;
const VENTURE_QUESTION_CUE = /\b(tell|what|whats?|about|explain|who|info|learn|describe|know)\b/i;
// Browse-events intent: "what's on", "upcoming events", "which events", "list
// events", "any events", "show events", + French ("événements à venir", "quoi
// de prévu"). Deliberately requires a listing cue so it doesn't swallow event
// *creation* ("create event …") or stray uses of the word "event".
// Two arms: word-initial English/"quoi de prévu" patterns keep \b boundaries;
// the French "événement(s)" arm is split out without a leading \b, since é is
// not a \w char so \b never borders it (and "événement" is distinctive enough
// to need no boundary). Create-event phrasing is routed earlier by
// CREATE_EVENT_CMD_RE, so overlap here is harmless.
const LIST_EVENTS_RE =
  /(?:\b(?:upcoming\s+events?|what'?s\s+on|list\s+(?:the\s+)?events?|any\s+events?|which\s+(?:are\s+the\s+)?(?:upcoming\s+)?events?|show\s+(?:me\s+)?(?:the\s+)?events?|what\s+events?|quoi\s+de\s+pr[ée]vu)\b|[ée]v[ée]nements\b|[ée]v[ée]nements?\s*(?:[àa]\s+venir|pr[ée]vus?))/i;
// "Is there an event named X?" / "do we have an event called X?" — a yes/no
// existence check for a SPECIFIC event, answered directly instead of dumping the
// whole what's-on list. Requires a name after the cue (a bare "is there any
// event?" has none → falls through to the list).
const EVENT_EXISTS_RE =
  /\b(?:is|are)\s+there\s+(?:any|an|a)?\s*events?(?:\s+(?:name\s+with|named?|called|titled?|like|with))?\s*["']?([^"'?]*[^\s"'?])["']?\s*\??\s*$|\bdo\s+(?:we|you|i)\s+have\s+(?:any|an|a)?\s*events?\s+(?:name\s+with|named?|called|titled?|like|with)\s*["']?([^"'?]*[^\s"'?])["']?\s*\??\s*$/i;
// An EXPLICIT create command (verb + event), as opposed to a bare "événement" or
// a list query. The `what's on` listing is routed before the create wizard (so
// the French "événement à venir" lands as a list, not creation), so it must
// defer to a real create command whose description happens to contain list words
// (e.g. "create event: upcoming-events recap").
const EXPLICIT_CREATE_RE =
  /^\s*(?:\/[\w-]*event|(?:create|new|add|start|make)[\s_-]+(?:a\s+|an\s+|a\s+new\s+|another\s+)?event|(?:cr[ée]er|nouvel|nouvelle|ajouter)[\s_-]+(?:un\s+|une\s+)?[ée]v[ée]nement)\b/i;
function isKnownIntent(body: string): boolean {
  const t = body.trim();
  if (/^\/?help\b/i.test(t)) return true;
  if (/^\/?stop\b/i.test(t)) return true;
  if (/\bfind me\b/i.test(t)) return true;
  // French finds/intros. Without these a FR member mid-onboarding has real
  // commands silently eaten as profile answers — observed live: "qui est là"
  // (who is here) was treated as the answer to onboarding step 3/4.
  if (/\btrouve[- ]?moi\b|\bpr[ée]sente[- ]?moi\b|\bmets[- ]?moi\s+en\s+relation\b|\bqui\s+devrais[- ]?je\s+rencontrer\b/i.test(t)) return true;
  if (/\bwho(?:'?s| is)?\s*(?:here|around)\b/i.test(t)) return true;
  if (/\bqui\s+est\s+(?:l[àa]|ici|pr[ée]sent|dans\s+le\s+coin)\b/i.test(t)) return true;
  if (/\bfree\s+(?:for|now)\b/i.test(t)) return true;
  if (/\b(?:libre|dispo(?:nible)?)\s+(?:pour|maintenant)\b/i.test(t)) return true;
  if (EXPLICIT_CREATE_RE.test(t) || /^\/event\b/i.test(t)) return true;
  // RSVP-status query — "have I signed in?", "am I in?", "which events am I in".
  if (RSVP_STATUS_RE.test(t)) return true;
  // "my connections / my contacts" — people you've connected with.
  if (MY_CONNECTIONS_RE.test(t)) return true;
  // Owner event management — `my events`, edit/cancel (typed or button callback).
  if (MY_EVENTS_QUERY_RE.test(t) && !EXPLICIT_CREATE_RE.test(t)) return true;
  if (CANCEL_EVENT_CMD_RE.test(t) || CANCELEVT_BTN_RE.test(t)) return true;
  if (EDIT_EVENT_CMD_RE.test(t) || EDITEVT_BTN_RE.test(t)) return true;
  if (INTROTO_BTN_RE.test(t)) return true;
  // `join <event>` RSVP (text or Join-button token) — answer it even mid-onboarding
  // so a broadcast that lands before sign-up finishes isn't eaten as a profile answer.
  if (JOIN_CMD_RE.test(t)) return true;
  if (isInterestCommand(t)) return true;
  if (LIST_EVENTS_RE.test(t)) return true;
  // Venture promo: a venture name AND a question/request cue (or a "?").
  if (VENTURE_RE.test(t) && (t.includes("?") || VENTURE_QUESTION_CUE.test(t))) return true;
  return false;
}

// `find me <topic>` is a *browse* (suggest names), never an intro — the intro is
// the separate `intro me to <name>` verb. `find me a buddy` IS an intro flow, so
// it's excluded. The prompt says all this, but a local model occasionally emits
// an `intro_buddy` marker on a topic browse anyway; we enforce the invariant in
// code (see the backstop below) so a topic search never creates a pending action.
export function isTopicBrowse(body: string): boolean {
  const t = body.trim();
  if (!/\bfind me\b/i.test(t)) return false;
  if (/\bfind\s+(?:me\s+)?(?:a\s+)?buddy\b/i.test(t)) return false;
  return true;
}

// `find me a buddy` (EN) + FR equivalents. The buddy flow is an interest-based
// match; the local model will happily pick a random member when it has nothing
// to match on, so when the requester has zero interests on file we intercept and
// ask instead (Shah, Jun 9: "matching anyone").
export function isBuddyIntent(body: string): boolean {
  const t = body.trim();
  if (/\bfind\s+(?:me\s+)?(?:a\s+)?buddy\b/i.test(t)) return true;
  if (/\btrouve[- ]?moi\b\s+(?:un\s+)?(?:bin[oô]me|quelqu'?un)\b/i.test(t)) return true;
  if (/\bqui\s+devrais[- ]?je\s+rencontrer\b/i.test(t)) return true;
  return false;
}

// True when we know SOMETHING to match the user on — a stated goal, legacy
// topics/lookingFor, or any enriched signal. When this is false the buddy match
// has nothing to go on, so we ask for an interest rather than guess.
export function hasAnyInterest(
  userData: Record<string, unknown>,
  enrichment: Record<string, unknown>
): boolean {
  const s = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const arr = (v: unknown) => Array.isArray(v) && v.length > 0;
  return (
    s(userData.goal) ||
    s(userData.lookingFor) ||
    arr(userData.topics) ||
    s(enrichment.bio) ||
    arr(enrichment.topics) ||
    s(enrichment.matchSignals) ||
    s(enrichment.company)
  );
}

// ── Layer-2 hallucination backstop ──────────────────────────────────────────
// A claim that a side effect ALREADY happened. The Claude path only PROPOSES
// actions (gated behind a Yes/No button) or informs — it never COMPLETES one.
// So a reply that asserts a finished action while carrying no valid action
// marker is a fabrication: e.g. "Cancelled." for an event the user doesn't host,
// when an off-vocabulary verb ("scrap", "call off") slipped past the router.
// The safe replies (menu, deflection) contain none of these words — the menu
// says "cancel"/"create", not "cancelled"/"created".
export const SUCCESS_CLAIM =
  /\b(cancell?ed|scrapped|deleted|removed|calls?\s+off|called\s+off|moved|updated|booked|scheduled|pinged|all set)\b|c['’]est\s+(annul[ée]e?|fait|cr[ée]{1,2})|\bannul[ée]e?\b/i;

// If the model fabricated a completed action with nothing real behind it, swallow
// the fake confirmation and fall back to the menu (what it should have said for a
// request it can't fulfil). Model-agnostic: even a hallucinating model can't get
// a false success past this. Legit proposals are exempt — they carry a marker
// (hasAction=true) and their prose is a "confirm with yes" proposal, not a claim.
export function guardFabricatedSuccess(
  reply: string,
  hasAction: boolean,
  lang: Lang
): string {
  if (!hasAction && SUCCESS_CLAIM.test(reply)) return msg(lang).menu;
  return reply;
}

// Strip a trailing confirm-CTA the model tacks on (EN + FR): "…? Reply `yes`."
// (intro proposals) or "Confirm with yes …" (event proposals). Only the last
// sentence is touched (the `[^.!\n]*` can't cross prior sentence ends), so the
// suggestion itself is preserved. Two uses: the topic-browse backstop below, and
// producing the Telegram body where a Yes/No button replaces the text CTA.
const TRAILING_YES_CTA_RE =
  /\s*(?:[^.!\n]*?\?\s*)?[`'"‘’]?\s*(?:reply|r[ée]ponds?|confirm(?:\s+with)?|confirme(?:\s+avec)?)\s+[`'"‘’]?(?:yes|oui)\b[`'"‘’]?[^.!?\n]*[.!?]?[`'"‘’]*\s*$/i;
function stripYesCta(reply: string): string {
  const stripped = reply.replace(TRAILING_YES_CTA_RE, "").trim();
  // If stripping ate everything (CTA was the whole reply), keep the original —
  // an empty Telegram body would be rejected by the send path.
  return stripped || reply;
}

// The typed "reply `intro me to <name>`" nudge a browse closes with (EN + FR
// nudges both spell the verb literally; the model is told to use it too). On
// Telegram, tappable Intro buttons replace it, so we strip it from the Telegram
// body — WhatsApp keeps it (Twilio has no buttons). We work sentence-by-sentence
// (not line-by-line) because the model often appends the CTA in the same
// paragraph as the suggestions — drop just the nudge sentences (incl. the
// "Want an intro?" lead-in), keep the suggestions.
const INTRO_NUDGE_SENTENCE_RE =
  /\b(?:intro me to|pr[ée]sente[- ]moi|want an intro|envie d'une intro)\b/i;
export function stripIntroNudge(reply: string): string {
  const sentences = reply.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [reply];
  const out = sentences
    .filter((s) => !INTRO_NUDGE_SENTENCE_RE.test(s))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // If the CTA was the whole reply, keep the original — an empty Telegram body
  // would be rejected by the send path (and the buttons still carry the action).
  return out || reply;
}

// "find me a climate VC" → "climate VC" (strip the verb and a leading article)
// for use in the intro opener / button callback_data.
export function introTopicFrom(body: string): string {
  return body
    .replace(/^.*?\bfind\s+me\b\s*/i, "")
    .replace(/^(?:a|an|the|some)\s+/i, "")
    .trim()
    .slice(0, 40);
}

// Build tappable "🤝 Intro: <Name>" buttons for a `find me <topic>` browse: scan
// the model's reply for member names from the directory it was given, in order
// of appearance, deduped, capped at 3 so the result stays uncluttered. `topic`
// (what they searched) rides in the callback_data so the tap's opener can name
// it — trimmed to keep `introto <uid> <topic>` within Telegram's 64-byte cap.
export function buildIntroButtons(
  reply: string,
  members: DirectoryMember[],
  lang: Lang,
  topic: string
): OutboxButton[] {
  const hay = reply.toLowerCase();
  const found: { idx: number; uid: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const name = (m.name || "").trim();
    if (!name || seen.has(m.uid)) continue;
    const idx = hay.indexOf(name.toLowerCase());
    if (idx < 0) continue;
    seen.add(m.uid);
    found.push({ idx, uid: m.uid, name });
  }
  found.sort((a, b) => a.idx - b.idx);
  return found.slice(0, 3).map((m) => {
    const room = 64 - `introto ${m.uid} `.length;
    const t = topic.slice(0, Math.max(0, room)).trim();
    const data = t ? `introto ${m.uid} ${t}` : `introto ${m.uid}`;
    return { text: `${msg(lang).btn.introTo} ${m.name}`.slice(0, 60), data };
  });
}

// ── Buddy matching (headline feature, deterministic) ─────────────────────────
// `find me a buddy` does NOT go to the local model — it would pick one semi-
// random person. Instead we rank the directory by embedding similarity to the
// requester's OWN interests (nearest-by-interest, reusing the vectors the
// directory pre-filter already builds), break ties by literal shared-topic
// overlap, and surface the top few — each with a one-tap Connect button. The
// user chooses; the bot doesn't guess a single answer.
const BUDDY_RESULTS = Number(process.env.BUDDY_RESULTS ?? 3);

// The requester's interests, for overlap scoring + the "you're both into …"
// line. Enriched topics win over legacy seed topics.
export function selfTopicList(
  userData: Record<string, unknown>,
  enrichment: Record<string, unknown>
): string[] {
  const enr = Array.isArray(enrichment.topics) ? (enrichment.topics as string[]) : [];
  const legacy = Array.isArray(userData.topics) ? (userData.topics as string[]) : [];
  return (enr.length ? enr : legacy).filter((t) => typeof t === "string" && t.trim());
}

// Topics shared between the requester and a candidate (case-insensitive), capped.
function sharedTopics(selfTopics: string[], m: DirectoryMember): string[] {
  const mine = new Set(selfTopics.map((t) => t.toLowerCase().trim()));
  const theirs = m.enrichedTopics.length ? m.enrichedTopics : m.topics;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of theirs) {
    const k = t.toLowerCase().trim();
    if (mine.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out.slice(0, 3);
}

// A short, user-facing "what they do" line (no uid, unlike formatMemberLine).
function buddyAbout(m: DirectoryMember): string {
  const bio = (m.enrichedBio || m.bio || "").trim();
  const company = (m.enrichedCompany || "").trim();
  if (bio) {
    const firstSentence = (bio.split(/(?<=[.!?])\s/)[0] ?? bio).slice(0, 100).trim();
    return company && !firstSentence.toLowerCase().includes(company.toLowerCase())
      ? `${firstSentence} (${company})`
      : firstSentence;
  }
  if (company) return company;
  if (m.goal) return m.goal.slice(0, 100).trim();
  const topics = m.enrichedTopics.length ? m.enrichedTopics : m.topics;
  if (topics.length) return `Into ${topics.slice(0, 3).join(", ")}`;
  return "";
}

// Rank reachable members by interest similarity to the requester. Semantic
// (cosine on cached embeddings) is primary; literal shared-topic count is a
// tiebreak and a fallback if embeddings are unavailable. A tiny freeUntil boost
// floats a reachable-right-now member up among near-equal matches.
export async function rankBuddies(
  members: DirectoryMember[],
  selfUid: string,
  selfQueryText: string,
  selfTopics: string[],
  limit: number
): Promise<{ m: DirectoryMember; shared: string[] }[]> {
  const others = members.filter((m) => m.uid !== selfUid);
  if (others.length === 0) return [];

  let qvec = memberEmbedCache.get(selfUid)?.vec;
  if (!qvec?.length && selfQueryText.trim()) {
    try {
      [qvec] = await embed([selfQueryText]);
    } catch (e) {
      console.warn(
        `[bot] buddy embed failed, ranking on topic overlap: ${e instanceof Error ? e.message : e}`
      );
      qvec = undefined;
    }
  }

  return others
    .map((m) => {
      const v = memberEmbedCache.get(m.uid)?.vec ?? [];
      const sem = qvec?.length && v.length ? cosine(qvec, v) : 0;
      const shared = sharedTopics(selfTopics, m);
      const score = sem + shared.length * 0.05 + (m.freeUntilMs ? 0.02 : 0);
      return { m, shared, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ m, shared }) => ({ m, shared }));
}

// The user-facing buddy list (numbered cards). `footer` differs by channel:
// Telegram gets a "tap below" hint (Connect buttons follow); WhatsApp gets the
// typed `intro me to <name>` nudge since it has no buttons.
export function buildBuddyReply(
  buddies: { m: DirectoryMember; shared: string[] }[],
  lang: Lang,
  footer: string
): string {
  const lines = [msg(lang).buddyIntro, ""];
  buddies.forEach(({ m, shared }, i) => {
    const about = buddyAbout(m);
    let card = `${i + 1}. ${m.name || "A member"}${about ? ` — ${about}` : ""}`;
    if (shared.length) card += `\n   ${msg(lang).buddyWhyShared(shared)}`;
    lines.push(card);
  });
  lines.push("", footer);
  return lines.join("\n");
}

// One "🤝 Connect <Name>" button per buddy. Reuses the proven `introto <uid>
// <reason>` callback the topic-browse buttons use, so a tap runs the same
// double-opt-in intro path. A shared topic (if any) rides along as the opener
// reason, trimmed to keep the callback within Telegram's 64-byte cap.
export function buildBuddyButtons(
  buddies: { m: DirectoryMember; shared: string[] }[],
  lang: Lang
): OutboxButton[] {
  return buddies.map(({ m, shared }) => {
    const reason = (shared[0] ?? "").trim();
    const room = 64 - `introto ${m.uid} `.length;
    const t = reason.slice(0, Math.max(0, room)).trim();
    const data = t ? `introto ${m.uid} ${t}` : `introto ${m.uid}`;
    return { text: `${msg(lang).btn.connect} ${m.name}`.slice(0, 60), data };
  });
}

// True when the model emitted the fallback menu (it's told to send it verbatim).
// Detected by the menu's distinctive first line so we can staple a few quick-
// action tap-buttons under it on Telegram.
export function isMenuReply(reply: string, lang: Lang): boolean {
  const firstLine = msg(lang).menu.split("\n")[0]?.trim();
  return !!firstLine && reply.includes(firstLine);
}

// The short quick-action button set under the fallback menu. callback_data is
// the canonical English command (matched by isKnownIntent in either language);
// only the label is localized. Kept to 4 so it never feels overwhelming.
export function menuButtons(lang: Lang): OutboxButton[] {
  return [
    { text: msg(lang).btn.menuBuddy, data: "find me a buddy" },
    { text: msg(lang).btn.menuWhatsOn, data: "what's on" },
    { text: msg(lang).btn.menuCreate, data: "create event" },
    { text: msg(lang).btn.menuWhoHere, data: "who is here" },
  ];
}

// ── Directory pre-filter (event-scale fix) ──────────────────────────────────
// At hundreds+ members the full directory in every prompt is the throughput
// bottleneck (it fills the context window → prefill dominates). Instead we embed
// members once (cached by profile hash) and inject only the top-K most relevant
// to the requester+message. The LLM still does the nuanced final pick, so the
// pre-filter only needs good recall — top-K=25 is generous for that.
const MEMBER_TOPK = Number(process.env.MEMBER_TOPK ?? 25);
const EMBED_BATCH = 128;

// uid → { hash of profile text, embedding }. Recomputed only when a member's
// profile changes; rebuilt from scratch on restart (cheap, batched).
const memberEmbedCache = new Map<string, { hash: string; vec: number[] }>();

function memberEmbedText(m: DirectoryMember): string {
  const topics = (m.enrichedTopics.length ? m.enrichedTopics : m.topics).join(", ");
  return [m.name, m.goal, m.enrichedBio || m.bio, topics, m.enrichedMatchSignals, m.enrichedCompany, m.lookingFor]
    .filter(Boolean)
    .join(" | ");
}

// Tiny stable hash — only needs to detect when a profile's text changed.
function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(h);
}

// Embed any members whose profile text isn't already cached. Batched + awaited;
// called inside the single-flight directory load so a burst embeds once, not N×.
export async function ensureMemberEmbeddings(members: DirectoryMember[]): Promise<void> {
  const stale = members.filter((m) => memberEmbedCache.get(m.uid)?.hash !== hashText(memberEmbedText(m)));
  for (let i = 0; i < stale.length; i += EMBED_BATCH) {
    const chunk = stale.slice(i, i + EMBED_BATCH);
    const vecs = await embed(chunk.map(memberEmbedText));
    chunk.forEach((m, j) => memberEmbedCache.set(m.uid, { hash: hashText(memberEmbedText(m)), vec: vecs[j] }));
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length !== a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Pick the members most relevant to this requester+message. Excludes the
 * requester, always keeps currently-free members (so FREE_NOW_MODE still has
 * candidates), and short-circuits for small communities (≤ K → no ranking).
 */
async function selectRelevantMembers(
  members: DirectoryMember[],
  selfUid: string,
  message: string,
  self: { goal?: string; topics?: string[] }
): Promise<DirectoryMember[]> {
  const others = members.filter((m) => m.uid !== selfUid);
  if (others.length <= MEMBER_TOPK) return others;

  const queryText = [message, self.goal ?? "", (self.topics ?? []).join(", ")].filter(Boolean).join(" | ");
  const [qvec] = await embed([queryText]);
  const ranked = others
    .map((m) => ({ m, score: cosine(qvec, memberEmbedCache.get(m.uid)?.vec ?? []) }))
    .sort((a, b) => b.score - a.score);

  const top = ranked.slice(0, MEMBER_TOPK).map((r) => r.m);
  const topSet = new Set(top.map((m) => m.uid));
  const free = others.filter((m) => m.freeUntilMs && !topSet.has(m.uid));
  return [...top, ...free];
}

// The directory block injected into the prompt — now a per-requester top-K slice.
function buildDirectoryBlock(members: DirectoryMember[]): string {
  if (members.length === 0) {
    return `## Member directory\n(empty — no other approved members yet; tell the user nobody else is here)`;
  }
  const lines = [`## Member directory (all approved members at VivaTech)`];
  for (const m of members) lines.push(formatMemberLine(m));
  return lines.join("\n");
}

// ── Upcoming events block ────────────────────────────────────────────────────
// The bot has no tool loop (the readEvents tool in tools.ts is a dead stub), so
// without this block it has zero awareness of scheduled events — asked "what's
// on" it would invent an answer. Like the member directory, the event list is
// identical for every user and changes slowly, so it's cached + injected rather
// than read per message.
interface UpcomingEvent {
  id: string;
  title: string;
  kind: string;
  startAtMs: number;
  addressNeighborhood: string;
  addressFull: string;
  hostUid: string;
  hostName: string;
  description: string;
}

async function loadUpcomingEvents(db: Firestore): Promise<UpcomingEvent[]> {
  // Single equality filter only (no orderBy) → no composite index needed; we
  // filter to future + sort in memory since the event set is tiny.
  const snap = await db.collection("events").where("status", "==", "scheduled").get();
  const now = Date.now();
  return snap.docs
    .map((d) => {
      const e = d.data();
      const startAtMs =
        e.startAt && typeof e.startAt.toMillis === "function"
          ? (e.startAt.toMillis() as number)
          : 0;
      return {
        id: d.id,
        title: String(e.title ?? ""),
        kind: String(e.kind ?? "other"),
        startAtMs,
        addressNeighborhood: String(e.addressNeighborhood ?? ""),
        addressFull: String(e.addressFull ?? ""),
        hostUid: String(e.hostUid ?? ""),
        hostName: String(e.hostName ?? ""),
        description: String(e.description ?? ""),
      };
    })
    // Future events + ones that started within the ongoing window (still
    // happening now) — so a live event isn't dropped the instant it begins.
    .filter((e) => e.startAtMs > now - ONGOING_WINDOW_MS)
    .sort((a, b) => a.startAtMs - b.startAtMs)
    .slice(0, 15);
}

// In-process events cache — same stale-while-revalidate + single-flight pattern
// as the member directory, so a burst of messages triggers one Firestore read.
const EVENTS_TTL_MS = Number(process.env.EVENTS_TTL_MS ?? 30_000);
// ONGOING_WINDOW_MS (imported from actions): an event with no explicit end is
// treated as "happening now" for this long after its start, so a currently-
// running event still shows in what's-on instead of vanishing the moment it
// begins — and can no longer be cancelled.
let eventsCache: { events: UpcomingEvent[]; loadedAt: number } | null = null;
let eventsInflight: Promise<UpcomingEvent[]> | null = null;

async function getUpcomingEvents(db: Firestore): Promise<UpcomingEvent[]> {
  const isFresh =
    eventsCache !== null && Date.now() - eventsCache.loadedAt < EVENTS_TTL_MS;

  if (!isFresh && eventsInflight === null) {
    eventsInflight = loadUpcomingEvents(db)
      .then((events) => {
        eventsCache = { events, loadedAt: Date.now() };
        return events;
      })
      .finally(() => {
        eventsInflight = null;
      });
    if (eventsCache !== null) eventsInflight.catch(() => {});
  }

  if (eventsCache !== null) return eventsCache.events; // fresh or stale-while-revalidate
  return eventsInflight!; // first ever load — wait for it
}

function formatEventLine(e: UpcomingEvent): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(e.startAtMs));
  const live = e.startAtMs > 0 && e.startAtMs <= Date.now();
  const parts = [`- ${live ? "[HAPPENING NOW] " : ""}${e.title}`, `· ${when} Paris`];
  // Public listings expose the neighborhood only — the exact address
  // (addressFull) is revealed to a member when they RSVP (see handleJoin), so we
  // deliberately never put it in the LLM context block.
  const place = e.addressNeighborhood;
  if (place) parts.push(`· ${place}`);
  if (e.hostName) parts.push(`· host: ${e.hostName}`);
  if (e.description) parts.push(`— ${e.description}`);
  return parts.join(" ");
}

// The upcoming-events block injected into the prompt. Empty case tells Claude to
// say so plainly + offer to create one (not invent events).
function buildEventsBlock(events: UpcomingEvent[]): string {
  if (events.length === 0) {
    return `## Upcoming events\n(none scheduled yet — if the user asks what's on, reply in ONE warm line that nothing's on the calendar yet and invite them to be the first via "create event". Reply with only that line — do NOT show the menu.)`;
  }
  const lines = [`## Upcoming events (scheduled, soonest first — Paris time)`];
  for (const e of events) lines.push(formatEventLine(e));
  return lines.join("\n");
}

async function appendTurns(
  db: Firestore,
  uid: string,
  newTurns: Turn[]
): Promise<void> {
  const ref = db.doc(`conversationStates/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = (snap.data()?.turns ?? []) as Turn[];
    const next = [...prev, ...newTurns].slice(-(HISTORY_LIMIT * 2));
    tx.set(
      ref,
      { uid, turns: next, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
}

interface SelfContext {
  goal?: string;
  energy?: string;
  enrichedBio?: string;
  enrichedTopics?: string[];
  enrichedCompany?: string;
  enrichedRecentActivity?: string;
  enrichedMatchSignals?: string;
  enrichmentStatus?: string;
}

function formatMemberLine(m: DirectoryMember): string {
  const parts = [`- ${m.name || m.uid} (uid ${m.uid})`];
  // Prefer enriched bio, fall back to legacy/seed bio.
  const bio = m.enrichedBio || m.bio;
  if (bio) parts.push(`— ${bio}`);
  if (m.enrichedCompany) parts.push(`· ${m.enrichedCompany}`);
  else if (m.city) parts.push(`· ${m.city}`);
  const topics = m.enrichedTopics.length > 0 ? m.enrichedTopics : m.topics;
  if (topics.length > 0) parts.push(`· topics: ${topics.join(", ")}`);
  if (m.goal) parts.push(`· goal: ${m.goal}`);
  if (m.energy) parts.push(`· energy: ${m.energy}`);
  if (m.enrichedMatchSignals) parts.push(`· wants to meet: ${m.enrichedMatchSignals}`);
  if (m.enrichedRecentActivity) parts.push(`· recent: ${m.enrichedRecentActivity}`);
  if (!m.enrichedBio && m.lookingFor) parts.push(`· looking for: ${m.lookingFor}`);
  if (m.freeUntilMs) {
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(m.freeUntilMs));
    parts.push(`· FREE until ${hhmm} Paris`);
  }
  return parts.join(" ");
}

function buildContextBlock(args: {
  uid: string;
  provider: Provider;
  displayName?: string;
  phone?: string;
  self: SelfContext;
  history: Turn[];
  pendingAction?: PendingAction;
  eventMode?: boolean;
  editMode?: boolean;
  editEvent?: {
    eventId: string;
    title: string;
    kind: string;
    startAtISO: string;
    addressNeighborhood: string;
    addressFull: string;
    capacity: number | null;
  };
  freeNowMode?: boolean;
  freeUntilMs?: number;
  lang: Lang;
}): string {
  const lines: string[] = [];
  // Language directive first — Claude's free-form replies must come back in
  // the user's preferred language.
  lines.push(claudeLanguageDirective(args.lang));
  lines.push(``);
  if (args.freeNowMode) {
    const until = args.freeUntilMs ? formatParisHHMM(args.freeUntilMs) : "soon";
    lines.push(`# FREE_NOW_MODE (single-turn directive)`);
    lines.push(
      `The user just signalled they're free right now — their availability is set until ${until} Paris time.`
    );
    lines.push(
      `Scan the Member directory for OTHER members marked "FREE until HH:MM" whose time is still in the future vs the current time below.`
    );
    lines.push(
      `Pick the 1 best match among those currently-free members (overlap on goal/topics/wants-to-meet). Reply: "You're free until ${until}. <Name> is free too — <1-line why>. Suggested opener: <line>." Then emit an intro_buddy action marker for that person so a 'yes' pings them.`
    );
    lines.push(
      `If NOBODY else in the directory is currently free, say exactly that in one line and offer the fallback: "Nobody else flagged free right now. Want a buddy for later? Reply find me a buddy." Emit NO marker in that case.`
    );
    lines.push(``);
  }
  if (args.eventMode) {
    lines.push(`# EVENT_CREATION_MODE (single-turn directive)`);
    lines.push(
      `The user just used the create-event command and this message is their event description.`
    );
    lines.push(
      `Parse it into a \`create_event\` action marker per your system prompt's Action markers section.`
    );
    lines.push(
      `Reply with a short human preview (e.g. "Drinks tonight 8pm — Café Marly. Confirm with yes to ping everyone.") and then the marker.`
    );
    lines.push(
      `If the description is missing time or title, ask ONE short follow-up question with no marker — do NOT fall back to the menu.`
    );
    lines.push(
      `If they're trying to cancel ("nvm", "skip", "actually no"), reply "Cancelled." with no marker.`
    );
    lines.push(``);
  }
  if (args.editMode && args.editEvent) {
    const e = args.editEvent;
    lines.push(`# EDIT_EVENT_MODE (single-turn directive)`);
    lines.push(
      `The user hosts this event and is describing a change to it. Apply ONLY what they ask; keep every other field as-is.`
    );
    lines.push(`Current event:`);
    lines.push(`- title: ${e.title}`);
    lines.push(`- kind: ${e.kind}`);
    lines.push(`- starts (ISO): ${e.startAtISO || "(unknown)"}`);
    lines.push(`- neighborhood: ${e.addressNeighborhood || "(none)"}`);
    lines.push(`- full address: ${e.addressFull || "(none)"}`);
    lines.push(`- capacity: ${e.capacity ?? "unlimited"}`);
    lines.push(
      `Reply with a one-line preview of the change (e.g. "Moved to 9:00 — Café X. Confirm with yes.") then an \`edit_event\` action marker.`
    );
    lines.push(
      `Marker: {"kind":"edit_event","changes":{ ...only the fields that change... }}. Allowed change fields: title, startAtISO (ISO-8601 Paris time, resolve "9am"/"tomorrow" against the current start above and the Paris time below), addressNeighborhood, addressFull, capacity. Do NOT include an eventId — the harness supplies it.`
    );
    lines.push(
      `If their message names no concrete change, ask ONE short follow-up with no marker. If they back out ("nvm"), reply "Cancelled." with no marker.`
    );
    lines.push(``);
  }
  lines.push(`# Current conversation context`);
  const nowParis = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  lines.push(`Current Paris time: ${nowParis}`);
  lines.push(`Current ISO timestamp: ${new Date().toISOString()}`);
  lines.push(`User uid: ${args.uid}`);
  lines.push(`(Never match or suggest this user to themselves — exclude uid ${args.uid} from results.)`);
  lines.push(`Channel: ${args.provider}`);
  if (args.phone) lines.push(`User phone: ${args.phone}`);
  if (args.displayName) lines.push(`User display name: ${args.displayName}`);
  // What the user told us in onboarding:
  if (args.self.goal) lines.push(`User goal at VivaTech: ${args.self.goal}`);
  if (args.self.energy) lines.push(`User energy preference: ${args.self.energy}`);
  // What background enrichment found from the web:
  if (args.self.enrichedBio) lines.push(`User professional bio (enriched): ${args.self.enrichedBio}`);
  if (args.self.enrichedCompany) lines.push(`User company: ${args.self.enrichedCompany}`);
  if (args.self.enrichedTopics && args.self.enrichedTopics.length > 0) {
    lines.push(`User topics (enriched): ${args.self.enrichedTopics.join(", ")}`);
  }
  if (args.self.enrichedRecentActivity) {
    lines.push(`User recent activity: ${args.self.enrichedRecentActivity}`);
  }
  if (args.self.enrichedMatchSignals) {
    lines.push(`User would benefit from meeting: ${args.self.enrichedMatchSignals}`);
  }
  if (args.self.enrichmentStatus && args.self.enrichmentStatus !== "complete") {
    lines.push(`(Enrichment status: ${args.self.enrichmentStatus} — profile may still be filling in.)`);
  }

  if (args.pendingAction) {
    lines.push(``);
    lines.push(`## Pending action`);
    lines.push(describePendingAction(args.pendingAction));
    lines.push(
      `(User reply was NOT a recognised yes/no — the action stays pending only if you re-emit the same marker. Otherwise it's cancelled by the harness.)`
    );
  }

  if (args.history.length > 0) {
    lines.push(``);
    lines.push(`## Recent turns (oldest first)`);
    for (const t of args.history) {
      lines.push(`${t.role === "user" ? "User" : "You"}: ${t.content}`);
    }
  }
  return lines.join("\n");
}

// `find me … VC/investor/angel/fund …`. Investor search is the marquee query at
// VivaTech, and the static prompt rule alone doesn't reliably stop the local 14B
// from picking a strong *topic* match of the wrong role (e.g. an AI-infra engineer
// for "AI VC") or someone who is merely *seeking* a VC. When we detect an investor
// query we inject a high-salience per-turn directive as the LAST system block so
// the model weights role over topic. Scoped to the investor direction on purpose —
// it only fires on explicit investor language, so it can't mis-filter other browses.
const INVESTOR_QUERY_RE =
  /\bfind\s+me\b.*\b(vc|vcs|venture\s+capitalists?|investors?|angels?|\blps?\b|limited\s+partners?|funds?)\b/i;

export function investorRoleDirective(userMessage: string): string {
  if (!INVESTOR_QUERY_RE.test(userMessage)) return "";
  return [
    "# ROLE FILTER (this turn only)",
    "The user is looking for an INVESTOR (VC / angel / fund). Suggest ONLY directory members who THEMSELVES invest — their bio/company names a fund, capital, ventures, partners, angel, or says investor/VC.",
    "A founder, operator, or engineer is NOT a match, however perfectly their topic overlaps. Someone whose `looking for`/`wants to meet` mentions VCs is the OPPOSITE side (they're hunting a VC, they aren't one) — exclude them.",
    "If NO member actually invests, say so in ONE line and offer `find me a buddy`. Never substitute a non-investor.",
  ].join("\n");
}

// "who did you ping / who's invited / who got the invite / pinging members" — asked
// after an event is created (the invite goes to everyone in the circle). The prompt
// covers this, but the local model sometimes falls back to the menu (Shah, Jun 8),
// so we force the who-is-here listing with a salient per-turn directive.
const WHO_PINGED_RE =
  /\b(?:who(?:m)?\s+(?:did|have|'ve)?\s*you\s+(?:ping|invite|notif\w*|tell|message)|who\s+got\s+the\s+invit|who'?s\s+invited|pinging\s+(?:the\s+)?members?|who\s+(?:are|were)\s+the\s+\w*\s*members?|qui\s+as[- ]?tu\s+(?:pr[ée]venu|invit[ée])|qui\s+est\s+invit[ée])/i;

export function whoPingedDirective(userMessage: string): string {
  if (!WHO_PINGED_RE.test(userMessage)) return "";
  return [
    "# DIRECTIVE (this turn only)",
    "The user is asking who you pinged / invited for an event. Creating an event invites EVERYONE in the circle, so this just means 'who's in the circle'.",
    "Answer EXACTLY like `who is here`: list 3–5 members from the Member directory, one short line each (name + what they do). Do NOT show the menu, do NOT describe the matcher, and emit no action marker.",
  ].join("\n");
}

async function runClaude(
  userMessage: string,
  directoryBlock: string,
  eventsBlock: string,
  volatileBlock: string,
  expectAction: boolean
): Promise<string> {
  // The static system prompt, the shared member directory, and the upcoming-events
  // block are stable across turns; the small per-request volatile block (time,
  // self, history) is not. The local backend gets these joined into one system
  // message; the Anthropic fallback applies ephemeral cache_control to all but the
  // last block (see llm.ts), so only the volatile block falls outside the cache.
  const directives = [
    investorRoleDirective(userMessage),
    whoPingedDirective(userMessage),
  ].filter(Boolean);
  const { text } = await runChat({
    system: [
      BASE_SYSTEM_PROMPT,
      directoryBlock,
      eventsBlock,
      volatileBlock,
      ...directives,
    ],
    user: userMessage,
    maxTokens: 400,
    // In EVENT_CREATION_MODE a create_event marker is mandatory — let a markerless
    // local reply fall back to Anthropic. Other turns legitimately have no marker.
    expectAction,
  });

  const reply = text.trim();
  if (!reply) throw new Error("LLM returned no text content");
  return reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) : reply;
}

async function writeOutbox(
  db: Firestore,
  args: {
    provider: Provider;
    uid: string;
    phone?: string;
    chatId?: number;
    body: string;
    type: string;
    // Telegram-only: tap-buttons + the body to show in their place. `body` stays
    // the WhatsApp/fallback text (keeps its inline "Reply …" CTA).
    buttons?: OutboxButton[];
    telegramBody?: string;
    // Telegram-only: mark a Yes/No confirmation keyboard as ephemeral so the
    // sender clears it once the next message supersedes it. Without this, a
    // confirmation answered by TYPING (not tapping) leaves the stale buttons
    // tappable — the webhook only clears a keyboard on an actual tap.
    ephemeralKeyboard?: boolean;
  }
): Promise<void> {
  const isTelegram = args.provider === "telegram";
  const body =
    isTelegram && args.telegramBody !== undefined ? args.telegramBody : args.body;
  const row: Record<string, unknown> = {
    recipientType: "individual",
    recipientUid: args.uid,
    type: args.type,
    provider: args.provider,
    body,
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
    scheduledFor: Timestamp.now(),
  };
  if (args.provider === "twilio" && args.phone) row.recipientPhone = args.phone;
  if (args.provider === "telegram" && args.chatId !== undefined) row.recipientChatId = args.chatId;
  if (isTelegram && args.buttons && args.buttons.length > 0) {
    row.buttons = args.buttons;
    if (args.ephemeralKeyboard) row.ephemeralKeyboard = true;
  }
  await db.collection("whatsappOutbox").add(row);
}

// `join <event>` / `rejoindre <event>` / `participer <event>` — RSVP. The arg is
// either an event id (the Join button's callback_data) or a title fragment (a
// user typing it). Requires a non-empty arg so a bare "join" doesn't match.
// Accepts the bare button token ("join <id>") and natural phrasings a member
// types: "I want to join Breakfast meet", "let me join the event Wine + agents",
// "can I join Morning run". Optional polite/intent lead-in + an optional "event"
// filler are stripped; the capture group is the event id or title fragment.
const JOIN_CMD_RE =
  /^\s*\/?(?:(?:i\s+(?:want|wanna|would\s+like|'?d\s+like)\s+(?:to\s+)?|i'?d\s+like\s+to\s+|let\s+me\s+|can\s+i\s+|please\s+|je\s+(?:veux|voudrais)\s+)?)(?:join|rejoindre|participer|rsvp(?:\s+to)?)\b[:\s-]*(?:(?:the\s+|l[ea']\s*)?(?:event|[ée]v[ée]nement)\s+)?(.+)$/i;

// ── Post-onboarding profile edit: add / remove / list interests ─────────────
// A signed-up member can tweak the topics the matcher uses without redoing the
// whole interview. "add interest cricket", "remove interest fintech", "my
// interests" (EN + FR). The keyword "interest(s)" / "intérêt(s)" / "centres
// d'intérêt" / "topic(s)" is required so it never swallows an event command.
const INTEREST_KEYWORD = `(?:interests?|int[ée]r[êe]ts?|centres?\\s+d['’]int[ée]r[êe]t|topics?)`;
const INTEREST_ADD_RE = new RegExp(
  `^\\s*(?:add|ajoute(?:r)?)\\s+(?:to\\s+my\\s+|me\\s+|my\\s+|a\\s+|an\\s+|une?\\s+|[àa]\\s+mes\\s+|mes\\s+)?${INTEREST_KEYWORD}\\s*[:\\-]?\\s*(.*)$`,
  "i"
);
const INTEREST_REMOVE_RE = new RegExp(
  `^\\s*(?:remove|delete|drop|retire(?:r)?|supprime(?:r)?|enl[èe]ve(?:r)?)\\s+(?:from\\s+my\\s+|my\\s+|de\\s+mes\\s+|mes\\s+)?${INTEREST_KEYWORD}\\s*[:\\-]?\\s*(.+)$`,
  "i"
);
const INTEREST_LIST_RE = new RegExp(
  `^\\s*(?:(?:show|list|view|see|what\\s+are)\\s+)?(?:my\\s+|mes\\s+)?${INTEREST_KEYWORD}\\s*\\??\\s*$`,
  "i"
);

export function isInterestCommand(t: string): boolean {
  return INTEREST_ADD_RE.test(t) || INTEREST_REMOVE_RE.test(t) || INTEREST_LIST_RE.test(t);
}

// Read the member's current interests from the field the matcher actually uses
// (enrichment.topics), falling back to the legacy top-level `topics`.
function currentInterests(userData: Record<string, unknown>): string[] {
  const enr = (userData.enrichment ?? {}) as Record<string, unknown>;
  if (Array.isArray(enr.topics)) return (enr.topics as string[]).filter(Boolean);
  const top = userData.topics;
  return Array.isArray(top) ? (top as string[]).filter(Boolean) : [];
}

// Handle an add/remove/list interests command, persisting to enrichment.topics so
// the change is live for the next match. Returns the user-facing reply, or null
// if the message isn't an interest command.
async function handleInterestCommand(
  db: Firestore,
  uid: string,
  userData: Record<string, unknown>,
  body: string,
  lang: Lang
): Promise<string | null> {
  const current = currentInterests(userData);

  const addM = body.match(INTEREST_ADD_RE);
  if (addM) {
    const toAdd = parseTopics(addM[1] ?? "");
    if (toAdd.length === 0) return msg(lang).interestsNothingToAdd;
    const have = new Set(current.map((t) => t.toLowerCase()));
    const merged = dedupeTopics([...current, ...toAdd]);
    const added = merged.filter((t) => !have.has(t.toLowerCase()));
    if (added.length === 0) {
      // Nothing new landed: either all were duplicates, or the list is full.
      return current.length >= MAX_TOPICS
        ? msg(lang).interestsFull(current)
        : msg(lang).interestsList(current);
    }
    await db.doc(`users/${uid}`).set({ enrichment: { topics: merged } }, { merge: true });
    return msg(lang).interestsAdded(added, merged);
  }

  const remM = body.match(INTEREST_REMOVE_RE);
  if (remM) {
    const target = remM[1].trim().toLowerCase();
    const hit = current.find((t) => t.toLowerCase() === target);
    if (!hit) return msg(lang).interestsNotFound(remM[1].trim(), current);
    const kept = current.filter((t) => t.toLowerCase() !== target);
    await db.doc(`users/${uid}`).set({ enrichment: { topics: kept } }, { merge: true });
    return msg(lang).interestsRemoved(hit, kept);
  }

  if (INTEREST_LIST_RE.test(body)) {
    return current.length ? msg(lang).interestsList(current) : msg(lang).interestsEmpty;
  }

  return null;
}

// Normalize a title/query for tolerant matching: lowercase, then fold any run of
// non-alphanumeric characters (so "·", ".", "-", extra spaces all collapse) into
// a single space. "Late lunch · Le Marais" and "Late launch . Le Marais" both
// normalize to comparable token streams.
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Levenshtein edit distance — only ever run on short event-title tokens.
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[a.length];
}

// Two title tokens count as the same word if they're identical, or a near-typo:
// edit-distance ≤1 for 4-char tokens, ≤2 for longer ones — but only when they
// share a first letter, which keeps "lauch"→"lunch" while blocking unrelated
// 2-edit collisions ("lunch"↛"bench").
function tokensMatch(qt: string, tt: string): boolean {
  if (tt === qt) return true;
  if (qt.length < 4 || tt[0] !== qt[0]) return false;
  return editDistance(qt, tt) <= (qt.length >= 5 ? 2 : 1);
}

// Tolerant title match for a typed join / RSVP-status query. Punctuation-blind
// substring first (either direction, preserving the old behavior), then a token
// pass so a small typo ("launch"/"lauch" → "lunch") or the "·"/"." separator
// still resolves. Conservative: EVERY query token must hit a title token, so a
// stray extra word makes it miss rather than mis-route to the wrong event — and
// the callers still require a UNIQUE event match before acting.
export function titleMatchesQuery(title: string, query: string): boolean {
  const t = normTitle(title);
  const q = normTitle(query);
  if (!t || !q) return false;
  if (t.includes(q) || q.includes(t)) return true;
  const qTokens = q.split(" ").filter(Boolean);
  const tTokens = t.split(" ").filter(Boolean);
  if (qTokens.length === 0) return false;
  return qTokens.every((qt) => tTokens.some((tt) => tokensMatch(qt, tt)));
}

export async function handleJoin(
  db: Firestore,
  uid: string,
  arg: string,
  lang: Lang
): Promise<{ reply: string; joined: boolean }> {
  // 1. Exact event id — the Join button sends `join <eventId>`.
  const byId = await db.doc(`events/${arg}`).get();
  let eventId: string | undefined;
  let title: string | undefined;
  let hostUid: string | undefined;
  if (byId.exists && byId.data()?.status === "scheduled") {
    eventId = byId.id;
    title = String(byId.data()?.title ?? "");
    hostUid = String(byId.data()?.hostUid ?? "");
  } else {
    // 2. Title match against scheduled future events — someone typed the name.
    const events = await getUpcomingEvents(db);
    const matches = events.filter((e) => titleMatchesQuery(e.title, arg));
    if (matches.length === 1) {
      eventId = matches[0].id;
      title = matches[0].title;
      hostUid = matches[0].hostUid;
    } else if (matches.length === 0) {
      return { reply: msg(lang).rsvpNotFound, joined: false };
    } else {
      return { reply: msg(lang).rsvpAmbiguous, joined: false };
    }
  }

  // You can't RSVP to an event you host — you're auto-RSVP'd on create. Catches
  // the typed `join <title>` path and any stale Join button for an own event.
  if (hostUid && hostUid === uid) {
    return { reply: msg(lang).rsvpOwnEvent(title || "the event"), joined: false };
  }

  const rsvpRef = db.collection("events").doc(eventId).collection("rsvps").doc(uid);

  // Already going? Don't silently re-RSVP — say they're already in (Shah, Jun 8:
  // "should respond that you have already joined"). We still reveal the details so
  // the reply is as useful as a fresh join.
  const existingRsvp = await rsvpRef.get();
  const alreadyGoing = existingRsvp.exists && existingRsvp.data()?.status === "going";

  // Event details to reveal on (re)join: the exact address (public listings only
  // show the neighborhood), the start time, and — if the host set up an Online
  // Tribes group — its invite link to coordinate with the other attendees.
  const evSnap =
    byId.exists && byId.id === eventId ? byId : await db.doc(`events/${eventId}`).get();
  const ev = (evSnap.data() ?? {}) as Record<string, unknown>;
  const place = String(ev.addressFull || ev.addressNeighborhood || "");
  const startAt = ev.startAt as Timestamp | undefined;
  const when =
    startAt && typeof startAt.toMillis === "function"
      ? formatParisDateTime(startAt.toMillis(), lang)
      : "";
  const groupLink = typeof ev.tribeLink === "string" ? ev.tribeLink : "";

  if (alreadyGoing) {
    return {
      reply: msg(lang).rsvpAlreadyJoined(title || "the event", place, when, groupLink || undefined),
      joined: false,
    };
  }

  await rsvpRef.set(
    { uid, status: "going", via: "bot_join", at: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return {
    reply: msg(lang).rsvpJoined(title || "the event", place, when, groupLink || undefined),
    joined: true,
  };
}

// RSVP-status questions — "have I signed in?", "am I in?", "did I join?",
// "which events am I going to?". Answered concisely from the user's own RSVPs
// instead of letting Claude dump the public what's-on list (tester #4).
const RSVP_STATUS_RE =
  /\b(?:have|did)\s+i\s+(?:sign(?:ed)?\s*in|join(?:ed)?|rsvp(?:'?d|ed)?)\b|\bam\s+i\s+(?:signed\s*in|in\b|going|attending|registered)|\bwhich\s+events?\s+am\s+i\b|\bmy\s+rsvps?\b|\bsuis-je\s+inscrit|\bje\s+suis\s+inscrit\b/i;

// When the user names ONE specific event in their status question — "have I
// signed in for Drink Night?", "am I going to the rooftop?" — capture that name
// so we answer about that event alone instead of dumping every RSVP (tester #4
// follow-up). The list-all variants ("which events am I in?", "my rsvps") carry
// no trailing name, so the capture group comes back empty and we list them all.
const RSVP_STATUS_EVENT_RE =
  /\b(?:(?:have|did)\s+i\s+(?:sign(?:ed)?\s*in|join(?:ed)?|rsvp(?:'?d|ed)?)|am\s+i\s+(?:signed\s*in|in|going|attending|registered)|suis-je\s+inscrit|je\s+suis\s+inscrit)\b\s+(?:(?:in|for|to|at|on|the|le|la|les|au|aux|pour|[àa]|l['’])\s+)*(.+)$/i;

// A captured fragment that's really a generic placeholder — "other event(s)",
// "any event", "another event", "anything else", "else" — NOT a specific event
// name. These mean "any of my events", so we list them all rather than searching
// for an event literally titled "other event" (Shah, Jun 8: asked "have I signed
// in [to any] other event" and got "you're not signed in for 'other event'").
const GENERIC_EVENT_FRAG =
  /^(?:(?:any|some|an|another|other|more|the\s+other|any\s+other)\s+)?events?$|^(?:any|other|others|another|anything(?:\s+else)?|something(?:\s+else)?|else)$/i;

// Pull the named-event fragment from an RSVP-status question, or "" if none (or
// if it's a generic placeholder → list all).
export function extractRsvpEventName(body: string): string {
  const m = body.match(RSVP_STATUS_EVENT_RE);
  if (!m) return "";
  const frag = m[1].replace(/[?!.\s]+$/g, "").trim();
  if (!frag || GENERIC_EVENT_FRAG.test(frag)) return "";
  return frag;
}

// List the events the caller has RSVP'd to (status "going"), soonest first.
// Uses a collection-group query over events/*/rsvps so it's a single read.
// When `eventName` is given, answer about just that one event: confirm if the
// caller is signed in for it, else say they aren't (rather than listing others).
async function buildMyRsvpsReply(
  db: Firestore,
  uid: string,
  lang: Lang,
  eventName = ""
): Promise<string> {
  const snap = await db
    .collectionGroup("rsvps")
    .where("uid", "==", uid)
    .where("status", "==", "going")
    .get();
  const now = Date.now();
  const rows: Array<{ title: string; when: string; ms: number }> = [];
  for (const d of snap.docs) {
    const eventRef = d.ref.parent.parent;
    if (!eventRef) continue;
    const ev = await eventRef.get();
    const data = ev.data();
    if (!ev.exists || !data || data.status !== "scheduled") continue;
    const startAt = data.startAt as Timestamp | undefined;
    const ms = startAt && typeof startAt.toMillis === "function" ? startAt.toMillis() : 0;
    if (ms && ms < now) continue; // past events drop off
    rows.push({
      title: String(data.title ?? "the event"),
      when: ms ? formatParisDateTime(ms, lang) : "",
      ms: ms || Number.MAX_SAFE_INTEGER,
    });
  }
  rows.sort((a, b) => a.ms - b.ms);
  // Asked about one specific event — narrow to it with the same tolerant matcher
  // the join path uses (punctuation-blind substring + small-typo tokens).
  const q = eventName.trim();
  if (q) {
    const hit = rows.filter((r) => titleMatchesQuery(r.title, q));
    if (hit.length === 0) return msg(lang).rsvpStatusNotFor(eventName.trim());
    return msg(lang).rsvpStatusList(
      hit.map((r) => (r.when ? `${r.title} · ${r.when}` : r.title))
    );
  }
  if (rows.length === 0) return msg(lang).rsvpStatusNone;
  return msg(lang).rsvpStatusList(
    rows.map((r) => (r.when ? `${r.title} · ${r.when}` : r.title))
  );
}

// "my connections / my contacts / who have I connected with" (FR: mes connexions/
// contacts). Franek (Jun 9): "a list of people with contacts that I'll be looking
// for." Lists the people the caller has actually connected with — both sides of an
// accepted intro — with each one's shareable contact (messaging handle + LinkedIn).
const MY_CONNECTIONS_RE =
  /\b(?:my\s+(?:connections?|contacts)|how\s+many\s+(?:connections?|contacts)|(?:connections?|contacts)\s+(?:do\s+)?i\s+have|who\s+(?:have|did)\s+i\s+connect(?:ed)?\s+with|people\s+i(?:'?ve)?\s+connect(?:ed)?\s+with|mes\s+(?:connexions?|contacts)|combien\s+de\s+(?:connexions?|contacts))\b/i;

// A message that is ESSENTIALLY just a greeting ("hi", "hello there", "bonjour").
// Anchored start-to-end so "hi, find me a buddy" still routes to the command — only
// a bare hello gets the warm intro + menu (Shah, Jun 9: bot should greet + introduce
// itself rather than coldly dumping the menu).
const GREETING_RE =
  /^\s*(?:hi+|hey+|hello+|hiya|howdy|yo|sup|hola|greetings|salut|bonjour|coucou|good\s+(?:morning|afternoon|evening|day))(?:\s+(?:there|tribu|bot|all|team|guys|everyone))?[\s!.,?]*$/i;

async function buildMyConnectionsReply(
  db: Firestore,
  uid: string,
  lang: Lang
): Promise<string> {
  // Accepted intros where the caller is either side. Two equality-only queries
  // (no composite index needed); merge into the set of "other" people.
  const [outgoing, incoming] = await Promise.all([
    db.collection("introRequests").where("fromUid", "==", uid).where("status", "==", "accepted").get(),
    db.collection("introRequests").where("toUid", "==", uid).where("status", "==", "accepted").get(),
  ]);
  const others = new Map<string, string>(); // otherUid -> name fallback
  for (const d of outgoing.docs) others.set(String(d.data().toUid), String(d.data().toName ?? ""));
  for (const d of incoming.docs) others.set(String(d.data().fromUid), String(d.data().fromName ?? ""));
  others.delete(uid);
  if (others.size === 0) return msg(lang).connectionsNone;

  const lines: string[] = [];
  for (const [otherUid, fallbackName] of others) {
    const snap = await db.doc(`users/${otherUid}`).get();
    const od = (snap.data() ?? {}) as Record<string, unknown>;
    const name = (od.displayName as string) || fallbackName || "A member";
    lines.push(`• ${contactText(lang, name, contactHandle(od), linkedinUrlOf(od))}`);
  }
  return msg(lang).connectionsList(lines);
}

// ── Owner event management (my events / edit / cancel) ──────────────────────
// These must be matched BEFORE the create-event wizard: CREATE_EVENT_CMD_RE
// matches a bare "événement", so "annuler événement" would otherwise be eaten as
// a creation attempt. cancel/edit accept a typed title fragment OR a literal
// event id — the `my events` inline keyboard sends `cancelevt <id>` / `editevt
// <id>` callbacks, which the webhook routes in as plain text.
const MY_EVENTS_RE = /^\s*\/?(?:my\s+events?|mes\s+[ée]v[ée]nements?)\s*$/i;
// First-person "events I host/created" questions. Without this, "Have I created
// any event?" matches the `any events?` arm of LIST_EVENTS_RE and gets answered
// with the public what's-on list instead of the caller's own events. Requires a
// possessive ("my events") or a past/retrospective frame ("events I created",
// "have I created … event") so it never swallows the "create event" command.
const MY_EVENTS_QUERY_RE =
  /\bmy\s+events?\b|\bmes\s+[ée]v[ée]nements?\b|\bevents?\s+(?:that\s+|did\s+|have\s+)?i(?:'m|’m| am)?\s+(?:create|created|host(?:ed|ing)?|made|make|own|organi[sz]ed?)\b|\b(?:what|which)\s+events?\s+(?:am|have|did)\s+i\s+(?:create|created|host(?:ed|ing)?|made|make|own|organi[sz]ed?)\b|\b(?:have|did)\s+i\s+(?:create|created|make|made|host|hosted|organi[sz]ed?)\b[^?]*?\bevents?\b/i;
// Verb + "event" + optional title. The `(?:…)?` determiner group tolerates a
// natural article between the two — "delete THE event chill session", "cancel MY
// event Drinks", "annuler L'événement X" — which otherwise fell through to Claude
// and got a hallucinated "cancelled!" reply with no actual write. `[\s_-]*` (not
// `?`) still accepts the button/slash forms ("cancelevent", "cancel_event").
const DETERMINER = "(?:(?:the|my|this|that|an?|le|la|les|mon|ma|mes|cet|cette)\\s+|l['’]\\s*)?";
// Verb sets are deliberately wide — every common way to say cancel/edit — so an
// off-vocabulary phrasing ("scrap my event", "call off the event") is handled
// deterministically (resolve-or-deny) instead of falling through to Claude, which
// fabricates a "Cancelled!" with no write. (Layer 2 guardFabricatedSuccess is the
// catch-all for phrasings that omit the literal word "event" entirely.)
const CANCEL_EVENT_CMD_RE = new RegExp(
  `^\\s*/?(?:cancel(?:\\s+out)?|delete|remove|scrap|ditch|drop|kill|scratch|nix|call\\s+off|annuler?|supprimer?|retirer?|enl[èe]ver?)[\\s_-]*${DETERMINER}(?:event|[ée]v[ée]nement)\\b[:\\s-]*(.*)$`,
  "i"
);
const EDIT_EVENT_CMD_RE = new RegExp(
  `^\\s*/?(?:edit|update|change|move|reschedule|push|shift|rename|adjust|modifier?|changer?|d[ée]placer?|reporter?)[\\s_-]*${DETERMINER}(?:event|[ée]v[ée]nement)\\b[:\\s-]*(.*)$`,
  "i"
);
const CANCELEVT_BTN_RE = /^\s*cancelevt\s+(\S+)\s*$/i;
const EDITEVT_BTN_RE = /^\s*editevt\s+(\S+)\s*$/i;
// Tap-button on `find me <topic>` results: `introto <uid> <optional topic>`.
// The topic (the thing they searched for) is carried so the opener can name it;
// it's optional because the callback_data is capped at 64 bytes (Telegram).
export const INTROTO_BTN_RE = /^\s*introto\s+(\S+)(?:\s+(.*))?$/i;

// `byId` is true when the arg is a literal event id (button callback), false
// when it's a typed title fragment.
function matchCancelEvent(text: string): { matched: boolean; byId: boolean; arg: string } {
  const btn = text.match(CANCELEVT_BTN_RE);
  if (btn) return { matched: true, byId: true, arg: btn[1] };
  const cmd = text.match(CANCEL_EVENT_CMD_RE);
  if (cmd) return { matched: true, byId: false, arg: cmd[1].trim() };
  return { matched: false, byId: false, arg: "" };
}
function matchEditEvent(text: string): { matched: boolean; byId: boolean; arg: string } {
  const btn = text.match(EDITEVT_BTN_RE);
  if (btn) return { matched: true, byId: true, arg: btn[1] };
  const cmd = text.match(EDIT_EVENT_CMD_RE);
  if (cmd) return { matched: true, byId: false, arg: cmd[1].trim() };
  return { matched: false, byId: false, arg: "" };
}

interface OwnedEvent {
  id: string;
  data: Record<string, unknown>;
}
type ResolveOwnedResult =
  | { ok: true; event: OwnedEvent }
  | { ok: false; reason: "notfound" | "notyours" | "ambiguous" | "cancelled"; title?: string };

// Resolve the event a cancel/edit command refers to, scoped to events the caller
// HOSTS (status=scheduled). By id (button) we still verify ownership; by title we
// only ever search the caller's own events, so a non-owner can never target one.
async function resolveOwnedEvent(
  db: Firestore,
  uid: string,
  arg: string,
  byId: boolean
): Promise<ResolveOwnedResult> {
  if (byId) {
    const snap = await db.doc(`events/${arg}`).get();
    if (!snap.exists) return { ok: false, reason: "notfound" };
    if (snap.data()?.hostUid !== uid) return { ok: false, reason: "notyours" };
    if (snap.data()?.status === "cancelled") {
      return { ok: false, reason: "cancelled", title: String(snap.data()?.title ?? "") };
    }
    if (snap.data()?.status !== "scheduled") return { ok: false, reason: "notfound" };
    return { ok: true, event: { id: snap.id, data: snap.data() ?? {} } };
  }
  // Title fragment — search only the caller's own scheduled events. Two equality
  // filters need no composite index (single-field indexes merge-join).
  const snap = await db
    .collection("events")
    .where("hostUid", "==", uid)
    .where("status", "==", "scheduled")
    .get();
  const mine: OwnedEvent[] = snap.docs.map((d) => ({ id: d.id, data: d.data() ?? {} }));
  const q = arg.trim().toLowerCase();
  const titleMatch = (e: OwnedEvent) => {
    const t = String(e.data.title ?? "").toLowerCase();
    return t.includes(q) || q.includes(t);
  };
  if (!q) {
    // No title given (e.g. bare "edit event") — use the only one, else ask.
    if (mine.length === 1) return { ok: true, event: mine[0] };
    return { ok: false, reason: mine.length === 0 ? "notfound" : "ambiguous" };
  }
  const matches = mine.filter(titleMatch);
  if (matches.length === 1) return { ok: true, event: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  // No scheduled match — check the caller's cancelled events so we can say "that
  // was cancelled" instead of a vague "couldn't find it" (Shah, Jun 9: "tried to
  // edit a cancelled event, got a wrong response").
  const cancelledSnap = await db
    .collection("events")
    .where("hostUid", "==", uid)
    .where("status", "==", "cancelled")
    .get();
  const cancMatch = cancelledSnap.docs
    .map((d) => ({ id: d.id, data: d.data() ?? {} }))
    .find(titleMatch);
  if (cancMatch) {
    return { ok: false, reason: "cancelled", title: String(cancMatch.data.title ?? "") };
  }
  return { ok: false, reason: "notfound" };
}

// The reason→message mapping shared by cancel and edit when resolution fails.
function ownedEventMissReply(
  res: { reason: "notfound" | "notyours" | "ambiguous" | "cancelled"; title?: string },
  lang: Lang
): string {
  if (res.reason === "notyours") return msg(lang).notYourEvent;
  if (res.reason === "ambiguous") return msg(lang).ownedEventAmbiguous;
  if (res.reason === "cancelled") {
    return msg(lang).eventAlreadyCancelled(res.title ?? "that event");
  }
  return msg(lang).rsvpNotFound;
}

// Build the `my events` reply: a list of the caller's scheduled events with
// per-event Edit/Cancel tap-buttons on Telegram, and a typed-command hint in the
// WhatsApp/fallback body.
async function buildMyEventsReply(
  db: Firestore,
  uid: string,
  lang: Lang
): Promise<{ body: string; telegramBody: string; buttons?: OutboxButton[] }> {
  const snap = await db
    .collection("events")
    .where("hostUid", "==", uid)
    .where("status", "==", "scheduled")
    .get();
  const mine = snap.docs
    .map((d) => {
      const e = d.data();
      const startAt = e.startAt as Timestamp | undefined;
      return {
        id: d.id,
        title: String(e.title ?? ""),
        startAtMs: startAt && typeof startAt.toMillis === "function" ? startAt.toMillis() : 0,
        neighborhood: String(e.addressNeighborhood ?? ""),
      };
    })
    // Drop events whose day is already past. A doc stays status="scheduled" after
    // its date (no auto-expiry), so without this a stale past event (observed:
    // "Breakfast · 28 May") lingers in `my events` with live Edit/Cancel buttons
    // it can't meaningfully act on. Keep today + future (and any without a date).
    .filter((e) => !e.startAtMs || parisDateKey(e.startAtMs) >= parisDateKey(Date.now()))
    .sort((a, b) => a.startAtMs - b.startAtMs);

  if (mine.length === 0) {
    const empty = msg(lang).myEventsEmpty;
    return { body: empty, telegramBody: empty };
  }

  const lines = [msg(lang).myEventsHeader];
  const buttons: OutboxButton[] = [];
  for (const e of mine) {
    const when = e.startAtMs ? formatParisDateTime(e.startAtMs, lang) : "";
    lines.push(`- ${e.title}${[when, e.neighborhood].filter(Boolean).length ? ` · ${[when, e.neighborhood].filter(Boolean).join(" · ")}` : ""}`);
    buttons.push({ text: `${msg(lang).btn.edit} ${e.title}`.slice(0, 60), data: `editevt ${e.id}` });
    buttons.push({ text: `${msg(lang).btn.cancelEvt} ${e.title}`.slice(0, 60), data: `cancelevt ${e.id}` });
  }
  const list = lines.join("\n");
  return {
    body: `${list}\n${msg(lang).myEventsHint}`,
    telegramBody: list,
    buttons,
  };
}

// Build the `what's on` reply: upcoming events with a per-event Join tap-button
// on Telegram (callback `join <id>`, resolved by handleJoin), and a typed-command
// hint in the WhatsApp/fallback body. Handled deterministically by the harness —
// the LLM can't emit Telegram buttons — so a member can RSVP with one tap instead
// of typing `join <title>`. Public listing shows the neighborhood only; the exact
// address is revealed on RSVP (mirrors the broadcast in actions.ts).
const WHATS_ON_MAX = 8;
export async function buildWhatsOnReply(
  db: Firestore,
  uid: string,
  lang: Lang
): Promise<{ body: string; telegramBody: string; buttons?: OutboxButton[] }> {
  const events = (await getUpcomingEvents(db)).slice(0, WHATS_ON_MAX);
  if (events.length === 0) {
    const empty = msg(lang).whatsOnEmpty;
    return { body: empty, telegramBody: empty };
  }
  // Events the caller already RSVP'd to ("going") — don't offer Join again; tag
  // the line instead (Shah, Jun 8: "join button should not appear with that event").
  const joinedSnap = await db
    .collectionGroup("rsvps")
    .where("uid", "==", uid)
    .where("status", "==", "going")
    .get();
  const joinedIds = new Set(
    joinedSnap.docs.map((d) => d.ref.parent.parent?.id).filter(Boolean) as string[]
  );
  const lines = [msg(lang).whatsOnHeader];
  const buttons: OutboxButton[] = [];
  const nowMs = Date.now();
  for (const e of events) {
    const when = e.startAtMs ? formatParisDateTime(e.startAtMs, lang) : "";
    const meta = [when, e.addressNeighborhood].filter(Boolean).join(" · ");
    const live = e.startAtMs > 0 && e.startAtMs <= nowMs;
    const tag = live ? (lang === "fr" ? "🔴 en cours · " : "🔴 now · ") : "";
    // Skip the Join button for an event you host (you're in as host) OR one you've
    // already joined — tag the line in both cases instead of offering Join again.
    const youHost = e.hostUid === uid;
    const joined = joinedIds.has(e.id);
    const stateTag = youHost
      ? (lang === "fr" ? " · (tu organises)" : " · (you host)")
      : joined
        ? (lang === "fr" ? " · (inscrit ✓)" : " · (going ✓)")
        : "";
    lines.push(`- ${tag}${e.title}${meta ? ` · ${meta}` : ""}${stateTag}`);
    if (!youHost && !joined) {
      buttons.push({ text: `${msg(lang).btn.join} ${e.title}`.slice(0, 60), data: `join ${e.id}` });
    }
  }
  const list = lines.join("\n");
  return { body: `${list}\n${msg(lang).whatsOnHint}`, telegramBody: list, buttons };
}

export async function processMessage(deps: ProcessMessageDeps): Promise<void> {
  const { db, inboxDoc } = deps;
  const inbox = inboxDoc.data();
  let body = String(inbox.body ?? "").trim();
  const uid = String(inbox.uid);
  const provider = (inbox.provider as Provider) ?? "twilio";
  const phone = inbox.phone ? String(inbox.phone) : undefined;
  const chatId = inbox.chatId as number | undefined;
  const voiceFileId = inbox.voiceFileId ? String(inbox.voiceFileId) : "";

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  const userData = (userSnap.data() ?? {}) as UserDocLike;
  const displayName = userData.displayName;
  const lang = normalizeLang(
    (userData as Record<string, unknown>).preferredLanguage
  );

  // Voice note (Telegram): no text body, but a voice file_id recorded by the
  // webhook. Download + transcribe locally (faster-whisper) and run the transcript
  // through the normal pipeline — so speaking a command works like typing it.
  if (!body && voiceFileId) {
    try {
      body = (await transcribeTelegramVoice(voiceFileId)).trim();
      console.log(
        `[bot] voice ${voiceFileId.slice(0, 12)}… -> ${JSON.stringify(body.slice(0, 80))}`
      );
    } catch (e) {
      console.warn(
        `[bot] voice transcription failed:`,
        e instanceof Error ? e.message : e
      );
    }
    if (!body) {
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: msg(lang).voiceUnclear,
        type: "voice_unclear",
      });
      await inboxDoc.ref.update({ intent: "voice_unclear" });
      return;
    }
  }

  // Non-text, non-voice attachment (photo/file/sticker) flagged by the webhook —
  // we can't read files; nudge them to text or a voice note instead of going
  // silent (Shah, Jun 9: "what should happen when you send an attachment?").
  if (!body && !voiceFileId && inbox.attachment === true) {
    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: msg(lang).attachmentUnsupported,
      type: "attachment_unsupported",
    });
    await appendTurns(db, uid, [
      { role: "user", content: "[attachment]", at: Timestamp.now() },
      { role: "assistant", content: msg(lang).attachmentUnsupported, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "attachment_unsupported" });
    return;
  }

  if (!body) {
    await inboxDoc.ref.update({ intent: "empty" });
    return;
  }

  const convoState = await loadConvoState(db, uid);

  // Language selection — handled before everything else so it always works.
  // `language` / `langue` (bare) shows options + parks awaitingLanguage;
  // `language fr` sets directly; a bare en/fr reply resolves a parked prompt.
  const langCmd = parseLanguageCommand(body);
  if (langCmd.matched) {
    if (langCmd.lang) {
      await setPreferredLanguage(db, uid, langCmd.lang);
      await setAwaitingLanguage(db, uid, false);
      const reply = msg(langCmd.lang).langSet(languageName(langCmd.lang));
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "language_set" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "language_set" });
      return;
    }
    await setAwaitingLanguage(db, uid, true);
    const reply = msg(lang).langPrompt;
    // 🇬🇧/🇫🇷 tap-buttons on Telegram. callback_data is "language en/fr" (not a
    // bare "en"/"fr") so parseLanguageCommand sets it directly even if the
    // awaitingLanguage prompt has since expired.
    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: reply,
      telegramBody: msg(lang).langPromptShort,
      buttons: [
        { text: "🇬🇧 English", data: "language en" },
        { text: "🇫🇷 Français", data: "language fr" },
      ],
      type: "language_prompt",
    });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "language_prompt" });
    return;
  }
  if (convoState.awaitingLanguage) {
    const picked = parseLangReply(body);
    if (picked) {
      await setPreferredLanguage(db, uid, picked);
      await setAwaitingLanguage(db, uid, false);
      const reply = msg(picked).langSet(languageName(picked));
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "language_set" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "language_set" });
      return;
    }
    // Not a language pick — abandon the prompt and let the message flow on.
    await setAwaitingLanguage(db, uid, false);
  }

  // Onboarding gate — if the user hasn't completed the profile, every inbound
  // message is treated as an answer to the current question. LinkedIn users
  // skip this. No Claude call until onboarding.step === "complete".
  //
  // EXCEPTION: a recognized intent (help / find / create event / who is here /
  // free / stop / a question about the ventures) is answered immediately even
  // mid-onboarding — otherwise a new user's real question gets silently consumed
  // as a profile answer (and pollutes their bio). Only genuine free-text falls
  // through to onboarding.
  // An active multi-turn flow (event-creation wizard, edit-event, OT-username,
  // a pending confirmation, or an incoming intro) owns the next free-text turn —
  // onboarding must NOT cut in front of it, or e.g. "Change the name to Dark
  // Night" mid-edit gets eaten by the "4 quick questions" profile interview.
  const inActiveFlow =
    !!convoState.awaitingOtUsername ||
    convoState.eventCreation?.step === "awaiting_description" ||
    convoState.editEvent?.step === "awaiting_changes" ||
    !!convoState.pendingAction ||
    !!convoState.pendingIntroRequest;
  if (!isKnownIntent(body) && !inActiveFlow) {
    const onboarding = await runOnboardingStep(userRef, userData, body, lang);
    if (onboarding.handled) {
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: onboarding.reply,
        type: "onboarding",
      });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: onboarding.reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "onboarding" });
      return;
    }
  }

  // Incoming intro request — this user was asked to connect with someone and
  // owes a yes/no. Checked BEFORE their own pendingAction because the request
  // prompt is the most recent thing they saw, and someone is waiting on them.
  const incomingIntro = convoState.pendingIntroRequest;
  if (incomingIntro) {
    // The buttons read "Connect" / "Pass" — accept those typed labels too, not
    // just yes/no, so a typed "Connect" actually completes the connection.
    if (isConnectWord(body)) {
      const result = await acceptIntroRequest(
        { db, uid, userData: userData as Record<string, unknown>, lang },
        incomingIntro
      );
      await clearPendingIntroRequest(db, uid);
      await writeOutbox(db, { provider, uid, phone, chatId, body: result.reply, type: "intro_accepted_self" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: result.reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "intro_accepted" });
      return;
    }
    if (isPassWord(body)) {
      const result = await declineIntroRequest(
        { db, uid, userData: userData as Record<string, unknown>, lang },
        incomingIntro
      );
      await clearPendingIntroRequest(db, uid);
      await writeOutbox(db, { provider, uid, phone, chatId, body: result.reply, type: "intro_declined_self" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: result.reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "intro_declined" });
      return;
    }
    // Neither yes nor no — they moved on. Expire the prompt (the request doc
    // stays "pending"; they can be re-asked later) and fall through to Claude.
    await clearPendingIntroRequest(db, uid);
  }

  const pending = convoState.pendingAction;

  // Pre-Claude: if there's a pendingAction and user confirms / cancels,
  // handle deterministically and skip Claude entirely.
  if (pending) {
    if (isYes(body)) {
      const result = await executePendingAction(
        { db, uid, userData: userData as Record<string, unknown>, lang },
        pending
      );
      await setPendingAction(db, uid, null);
      // The event's group chat (Online Tribes tribe) is created automatically
      // under the Viva Tribe service account inside executeCreateEvent — its
      // invite link is already in result.reply. We never ask the host for an OT
      // username (zero-friction; everyone joins via the link).
      const reply = result.reply;
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: reply,
        type: "action_confirm",
      });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "action_executed" });
      return;
    }
    if (isNo(body)) {
      await setPendingAction(db, uid, null);
      const cancelMsg = msg(lang).cancelled;
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: cancelMsg,
        type: "action_cancel",
      });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: cancelMsg, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "action_cancelled" });
      return;
    }
    // Anything else expires the pending action — the user moved on.
    await setPendingAction(db, uid, null);
  }

  // DORMANT (kept for a possible future host-owned-tribe option): the OT-username
  // follow-up that used to run after event creation. Event tribes are now created
  // automatically under the Viva Tribe service account (no username ask), so
  // nothing sets `awaitingOtUsername` and this branch is currently unreachable.
  if (convoState.awaitingOtUsername) {
    const st = convoState.awaitingOtUsername;
    const eventId = st.eventId;
    if (/^(cancel|nvm|skip|abort|annuler|annule|laisse tomber|passe|later|plus tard)$/i.test(body)) {
      await setAwaitingOtUsername(db, uid, null);
      const reply = msg(lang).otUsernameSkipped;
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "ot_username_skip" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "ot_username_skipped" });
      return;
    }

    // Decide which handle to actually create the tribe under THIS turn. We never
    // create straight off a typed handle — we echo it back for confirmation
    // first (a mistyped/garbage handle like "Hello" can match a stranger's OT
    // account and hand them the group). Only a "yes" on the echoed handle uses it.
    let usernameToCreate: string | null = null;
    if (st.pendingUsername && isYes(body)) {
      usernameToCreate = st.pendingUsername;
    } else if (st.pendingUsername && isNo(body)) {
      await setAwaitingOtUsername(db, uid, null);
      const reply = msg(lang).otUsernameSkipped;
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "ot_username_skip" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "ot_username_skipped" });
      return;
    }

    if (!usernameToCreate) {
      // Treat the message as a (new) candidate handle. If it's a real command or
      // clearly not a username, drop the prompt and let normal routing handle it.
      const candidate = extractOtUsername(body);
      if (isKnownIntent(body) || !candidate) {
        await setAwaitingOtUsername(db, uid, null);
        // fall through to normal command/Claude routing below.
      } else {
        // Resolve the handle to its real OT owner FIRST, then confirm by name —
        // so a handle that matches a stranger ("Hello") is caught before the
        // group is created. We persist the canonical username the endpoint
        // returns, not the raw input.
        const resolved = await resolveOtOwner(candidate);
        let reply: string;
        let intent: string;
        if (resolved.ok) {
          await db.doc(`conversationStates/${uid}`).set(
            {
              uid,
              awaitingOtUsername: {
                eventId,
                startedAt: st.startedAt,
                attempts: st.attempts ?? 0,
                pendingUsername: resolved.ownerUsername,
              },
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          reply = msg(lang).otUsernameConfirm(resolved.ownerUsername, resolved.ownerName);
          intent = "ot_username_confirm";
        } else if (resolved.reason === "username_not_found") {
          // Unknown handle — retry once, then give up gracefully.
          const attempts = (st.attempts ?? 0) + 1;
          if (attempts >= 2) {
            await setAwaitingOtUsername(db, uid, null);
            reply = msg(lang).otUsernameSkipped;
            intent = "ot_username_giveup";
          } else {
            await db.doc(`conversationStates/${uid}`).set(
              {
                uid,
                awaitingOtUsername: { eventId, startedAt: st.startedAt, attempts },
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            reply = msg(lang).otUsernameNotFound;
            intent = "ot_username_notfound";
          }
        } else {
          // Endpoint down / not configured — fall back to confirming the raw
          // handle (no name) so the flow still works.
          await db.doc(`conversationStates/${uid}`).set(
            {
              uid,
              awaitingOtUsername: {
                eventId,
                startedAt: st.startedAt,
                attempts: st.attempts ?? 0,
                pendingUsername: candidate,
              },
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          reply = msg(lang).otUsernameConfirm(candidate, candidate);
          intent = "ot_username_confirm";
        }
        await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "ot_username_confirm" });
        await appendTurns(db, uid, [
          { role: "user", content: body, at: Timestamp.now() },
          { role: "assistant", content: reply, at: Timestamp.now() },
        ]);
        await inboxDoc.ref.update({ intent });
        return;
      }
    } else {
      // Confirmed → create the tribe under the confirmed handle.
      const username = usernameToCreate;
      const evSnap = await db.doc(`events/${eventId}`).get();
      let reply: string;
      let intent: string;
      if (!evSnap.exists || evSnap.data()?.status !== "scheduled") {
        await setAwaitingOtUsername(db, uid, null);
        reply = msg(lang).otUsernameSkipped;
        intent = "ot_username_eventgone";
      } else {
        const ev = evSnap.data() ?? {};
        const tribe = await createTribeForHost({
          ownerUsername: username,
          name: String(ev.title ?? "the event"),
          bio: (ev.description as string) || undefined,
        });
        if (tribe.ok) {
          await db.doc(`users/${uid}`).set({ onlineTribesUsername: username }, { merge: true });
          await db.doc(`events/${eventId}`).set({ tribeLink: tribe.inviteLink }, { merge: true });
          await setAwaitingOtUsername(db, uid, null);
          reply = msg(lang).tribeReady(tribe.inviteLink);
          intent = "ot_username_set";
        } else if (tribe.reason === "username_not_found") {
          // Drop the rejected handle and ask afresh; retry once, then give up.
          const attempts = (st.attempts ?? 0) + 1;
          if (attempts >= 2) {
            await setAwaitingOtUsername(db, uid, null);
            reply = msg(lang).otUsernameSkipped;
            intent = "ot_username_giveup";
          } else {
            await db.doc(`conversationStates/${uid}`).set(
              {
                uid,
                awaitingOtUsername: { eventId, startedAt: st.startedAt, attempts },
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            reply = msg(lang).otUsernameNotFound;
            intent = "ot_username_notfound";
          }
        } else {
          await setAwaitingOtUsername(db, uid, null);
          reply = msg(lang).otUsernameError;
          intent = "ot_username_error";
        }
      }
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "ot_username" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent });
      return;
    }
  }

  // RSVP — `join <event>` (typed by name) or the Join button's `join <eventId>`
  // token. Deterministic write of events/{id}/rsvps/{uid}; no Claude call.
  const joinMatch = body.match(JOIN_CMD_RE);
  if (joinMatch) {
    const result = await handleJoin(db, uid, joinMatch[1].trim(), lang);
    await writeOutbox(db, { provider, uid, phone, chatId, body: result.reply, type: "rsvp" });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: result.reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: result.joined ? "rsvp_joined" : "rsvp_miss" });
    return;
  }

  // Profile edit — `add interest <x>` / `remove interest <x>` / `my interests`.
  // Lets a signed-up member tune the topics the matcher uses, deterministically
  // (no Claude call), so a post-onboarding "add cricket" isn't mistaken for an
  // event proposal.
  const interestReply = await handleInterestCommand(
    db,
    uid,
    userData as Record<string, unknown>,
    body,
    lang
  );
  if (interestReply !== null) {
    await writeOutbox(db, { provider, uid, phone, chatId, body: interestReply, type: "interests" });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: interestReply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "interests" });
    return;
  }

  // ── Owner event management: my events / cancel / edit ─────────────────────
  // Routed before the create-event wizard (CREATE_EVENT_CMD_RE matches a bare
  // "événement", which would otherwise swallow "annuler événement").

  // RSVP-status query — "have I signed in?", "am I in?", "which events am I
  // going to?". Answered from the caller's own RSVPs, before the what's-on /
  // my-events listings so it isn't swallowed by either.
  // Wizard escape hatch: if the user sends a recognized command while we're mid
  // event-creation/edit, they've moved on — drop the wizard so the command routes
  // normally instead of being eaten as the description we asked for (Shah, Jun 9:
  // stuck looping on "give me title + when + where" after an incomplete create).
  if (
    isKnownIntent(body) &&
    (convoState.eventCreation?.step || convoState.editEvent?.step)
  ) {
    if (convoState.eventCreation?.step) {
      await setEventCreation(db, uid, null);
      convoState.eventCreation = undefined;
    }
    if (convoState.editEvent?.step) {
      await setEditEvent(db, uid, null);
      convoState.editEvent = undefined;
    }
  }

  // Bare greeting → warm hello + one-line intro + the menu (with quick-action
  // buttons), instead of the cold menu-only fallback (Shah, Jun 9). Skipped while
  // a wizard is mid-flow so a "hi" during event creation isn't hijacked.
  if (
    GREETING_RE.test(body) &&
    !convoState.eventCreation?.step &&
    !convoState.editEvent?.step
  ) {
    const reply = `${msg(lang).greetingIntro}\n\n${msg(lang).menu}`;
    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: reply,
      buttons: menuButtons(lang),
      type: "greeting",
    });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "greeting" });
    return;
  }

  // "my connections" — people you've connected with (accepted intros) + contacts.
  if (MY_CONNECTIONS_RE.test(body)) {
    const reply = await buildMyConnectionsReply(db, uid, lang);
    await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "my_connections" });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "my_connections" });
    return;
  }

  if (RSVP_STATUS_RE.test(body)) {
    const reply = await buildMyRsvpsReply(db, uid, lang, extractRsvpEventName(body));
    await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "rsvp_status" });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "rsvp_status" });
    return;
  }

  // `my events` (or "have I created any event?", "events I host", …) — list the
  // caller's own events with Edit/Cancel tap-buttons. The broader query form is
  // matched here, before LIST_EVENTS_RE, so first-person ownership questions
  // aren't answered with the public what's-on list. But it also matches "my
  // event" *inside* an edit/cancel command ("change my event to 6pm", "cancel my
  // event Drinks"), so defer to those handlers — otherwise the command is eaten
  // by the list and the user's actual change/cancel intent is dropped.
  if (
    MY_EVENTS_QUERY_RE.test(body) &&
    !EXPLICIT_CREATE_RE.test(body) &&
    !matchEditEvent(body).matched &&
    !matchCancelEvent(body).matched
  ) {
    const r = await buildMyEventsReply(db, uid, lang);
    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: r.body,
      telegramBody: r.telegramBody,
      buttons: r.buttons,
      type: "my_events",
    });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: r.body, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "my_events" });
    return;
  }

  // "Is there an event named X?" — a yes/no existence check, answered directly
  // (before the what's-on list so it isn't swallowed by the "any event" arm).
  const existsMatch = body.match(EVENT_EXISTS_RE);
  if (existsMatch && !EXPLICIT_CREATE_RE.test(body)) {
    const query = (existsMatch[1] || existsMatch[2] || "").trim().toLowerCase();
    const events = await getUpcomingEvents(db);
    const hit = events.find(
      (e) =>
        e.title.toLowerCase().includes(query) || query.includes(e.title.toLowerCase())
    );
    const reply = hit
      ? (lang === "fr"
          ? `✅ Oui — « ${hit.title} » est prévu.`
          : `✅ Yes — "${hit.title}" is on the calendar.`)
      : (lang === "fr"
          ? `Non — aucun événement « ${query} » pour l'instant. Réponds « quoi de prévu » pour voir l'agenda.`
          : `No — there's no event called "${query}" yet. Reply "upcoming events" to see what's scheduled.`);
    await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "event_exists" });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: hit ? "event_exists_yes" : "event_exists_no" });
    return;
  }

  // `what's on` / upcoming events — list scheduled events with a per-event Join
  // tap-button on Telegram (typed `join <title>` still works as the fallback).
  // Deterministic (the LLM can't emit buttons). Routed before the create wizard
  // so the French "événement à venir" lands as a list, but deferring to an
  // explicit create command so its description can still mention list words.
  if (LIST_EVENTS_RE.test(body) && !EXPLICIT_CREATE_RE.test(body)) {
    const r = await buildWhatsOnReply(db, uid, lang);
    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: r.body,
      telegramBody: r.telegramBody,
      buttons: r.buttons,
      type: "whats_on",
    });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: r.body, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "whats_on" });
    return;
  }

  // `cancel event <title>` / `delete event <title>` / button `cancelevt <id>` —
  // resolve + ownership-check, then stage a `cancel_event` pendingAction so the
  // destructive step needs an explicit `yes` (the existing yes/no fast-path runs
  // executeCancelEvent → soft-delete + notify attendees).
  const cancelCmd = matchCancelEvent(body);
  if (cancelCmd.matched) {
    const res = await resolveOwnedEvent(db, uid, cancelCmd.arg, cancelCmd.byId);
    let reply: string;
    let buttons: OutboxButton[] | undefined;
    if (!res.ok) {
      reply = ownedEventMissReply(res, lang);
    } else {
      const title = String(res.event.data.title ?? "");
      const startAt = res.event.data.startAt as Timestamp | undefined;
      const startAtMs =
        startAt && typeof startAt.toMillis === "function" ? startAt.toMillis() : 0;
      if (isLockedForChanges(startAtMs, Date.now())) {
        // Event is today or underway — locked. Refuse; don't stage a confirmation.
        reply = msg(lang).cantCancelLocked(title);
      } else {
        const rsvps = await db
          .collection("events")
          .doc(res.event.id)
          .collection("rsvps")
          .where("status", "==", "going")
          .get();
        const attendees = rsvps.docs.filter((d) => d.id !== uid).length;
        await setPendingAction(db, uid, { kind: "cancel_event", eventId: res.event.id, title });
        reply = msg(lang).cancelConfirm(title, attendees);
        buttons = [
          { text: msg(lang).btn.yesCancel, data: "yes" },
          { text: msg(lang).btn.no, data: "no" },
        ];
      }
    }
    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: reply,
      telegramBody: buttons ? stripYesCta(reply) : undefined,
      buttons,
      ephemeralKeyboard: !!buttons,
      type: "cancel_confirm",
    });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: res.ok ? "cancel_confirm" : "cancel_miss" });
    return;
  }

  // `edit event <title>` / button `editevt <id>` — resolve + ownership-check,
  // then park editEvent state and ask what to change. The next free-text turn is
  // routed to Claude in EDIT_EVENT_MODE (handled in the wizard block below).
  // Mode flags + the body that actually reaches Claude. Declared here (above the
  // edit handler) so an inline edit ("change my event to 6pm") can set them and
  // fall straight through to the EDIT_EVENT_MODE Claude turn this same turn,
  // skipping the extra "what should change?" round-trip.
  let eventMode = false;
  let editMode = false;
  // How many times we've already re-asked for a usable event description this
  // wizard — carried into the runClaude catch to cap the "give me details" loop.
  let eventTries = 0;
  let editEventId: string | undefined;
  let editEventData: Record<string, unknown> | undefined;
  let claudeBody = body;

  const editCmd = matchEditEvent(body);
  if (editCmd.matched) {
    let res = await resolveOwnedEvent(db, uid, editCmd.arg, editCmd.byId);
    // Inline change — "change my event to start at 6pm" carries the change in the
    // arg, not a title. If the arg didn't resolve as a title and the host owns
    // exactly one event, treat the arg as the change and apply it this turn.
    // (Button callbacks always carry a real event id, so are never reinterpreted.)
    let inlineChange = "";
    if (!editCmd.byId && !res.ok && res.reason === "notfound" && editCmd.arg.trim()) {
      const sole = await resolveOwnedEvent(db, uid, "", false);
      if (sole.ok) {
        res = sole;
        inlineChange = editCmd.arg.trim();
      } else if (sole.reason === "ambiguous") {
        res = sole; // host has several events — ask which one rather than guess.
      }
    }
    if (!res.ok) {
      const reply = ownedEventMissReply(res, lang);
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "edit_prompt" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "edit_miss" });
      return;
    }
    // Locked once it's the event's own day (or underway) — same rule as cancel.
    // Refuse before entering EDIT_EVENT_MODE so the host can't tweak a live event.
    const editStartAt = res.event.data.startAt as Timestamp | undefined;
    const editStartMs =
      editStartAt && typeof editStartAt.toMillis === "function" ? editStartAt.toMillis() : 0;
    if (isLockedForChanges(editStartMs, Date.now())) {
      const reply = msg(lang).cantEditLocked(String(res.event.data.title ?? "the event"));
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "edit_locked" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "edit_locked" });
      return;
    }
    if (inlineChange) {
      // Route straight into EDIT_EVENT_MODE with the change as the message.
      editMode = true;
      editEventId = res.event.id;
      editEventData = res.event.data;
      claudeBody = inlineChange;
    } else {
      await setEditEvent(db, uid, res.event.id);
      const reply = msg(lang).editPrompt(String(res.event.data.title ?? "the event"));
      await writeOutbox(db, { provider, uid, phone, chatId, body: reply, type: "edit_prompt" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: reply, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "edit_started" });
      return;
    }
  }

  // `introto <uid> <topic>` — the tap-button shown next to each person on a
  // `find me <topic>` result. Per the button-driven UX, tapping sends the intro
  // request immediately (no extra Yes/No) — it's double opt-in, so nothing is
  // shared until the recipient taps Connect. We build a deterministic opener
  // (topic-aware when the search term rode along in the callback_data) and run
  // the same intro path a typed `yes` would.
  const introtoCmd = body.match(INTROTO_BTN_RE);
  if (introtoCmd) {
    const targetUid = introtoCmd[1];
    const topic = (introtoCmd[2] ?? "").trim().slice(0, 60);
    const opener = topic
      ? msg(lang).introtoOpener(topic)
      : msg(lang).introtoOpenerGeneric;
    const result = await executePendingAction(
      { db, uid, userData: userData as Record<string, unknown>, lang },
      { kind: "intro_buddy", targetUid, opener }
    );
    await writeOutbox(db, { provider, uid, phone, chatId, body: result.reply, type: "introto" });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: result.reply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "introto" });
    return;
  }

  // Event-creation wizard.
  //
  // Three entry points to the same final state ("eventMode = true, claudeBody
  // is the description"):
  //   1. `create event` with nothing after → ask for description, return
  //      (next turn picks up here through path 3)
  //   2. `create event drinks tonight 8pm` → inline; description = rest of msg
  //   3. previous turn set step=awaiting_description → this msg IS the description
  //
  // In modes 2 and 3, we set eventMode = true and route the message to Claude
  // with the EVENT_CREATION_MODE directive in the context block. Claude returns
  // a create_event action marker which the existing post-Claude parser stores
  // as a pendingAction; the user then confirms with `yes` to actually write
  // the event + fan out the broadcast.
  const createCmd = matchCreateEventCommand(body);
  if (createCmd.matched) {
    if (!createCmd.rest) {
      await setEventCreation(db, uid, "awaiting_description");
      const promptMsg = msg(lang).createEventPrompt;
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: promptMsg,
        type: "event_wizard_prompt",
      });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: promptMsg, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "event_wizard_started" });
      return;
    }
    eventMode = true;
    claudeBody = createCmd.rest;
  } else if (convoState.eventCreation?.step === "awaiting_description") {
    if (/^(cancel|nvm|skip|abort|annuler|annule|laisse tomber)$/i.test(body)) {
      await setEventCreation(db, uid, null);
      const cancelMsg = msg(lang).cancelled;
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: cancelMsg,
        type: "event_wizard_cancel",
      });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: cancelMsg, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "event_wizard_cancelled" });
      return;
    }
    eventMode = true;
    eventTries = convoState.eventCreation.tries ?? 0;
    await setEventCreation(db, uid, null);
  } else if (convoState.editEvent?.step === "awaiting_changes") {
    // Continuation of `edit event` — this message describes the change(s).
    if (/^(cancel|nvm|skip|abort|annuler|annule|laisse tomber)$/i.test(body)) {
      await setEditEvent(db, uid, null);
      const cancelMsg = msg(lang).cancelled;
      await writeOutbox(db, { provider, uid, phone, chatId, body: cancelMsg, type: "edit_cancel" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: cancelMsg, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "edit_cancelled" });
      return;
    }
    const evId = convoState.editEvent.eventId;
    const evSnap = await db.doc(`events/${evId}`).get();
    // Re-verify the event still exists, is scheduled, and is still theirs before
    // spending a Claude turn on it.
    if (
      !evSnap.exists ||
      evSnap.data()?.status !== "scheduled" ||
      evSnap.data()?.hostUid !== uid
    ) {
      await setEditEvent(db, uid, null);
      const gone = msg(lang).eventGone;
      await writeOutbox(db, { provider, uid, phone, chatId, body: gone, type: "edit_gone" });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: gone, at: Timestamp.now() },
      ]);
      await inboxDoc.ref.update({ intent: "edit_gone" });
      return;
    }
    editMode = true;
    editEventId = evId;
    editEventData = evSnap.data() ?? {};
    await setEditEvent(db, uid, null);
  }

  // Free-now: write the user's availability window deterministically (Claude
  // has no tool to write it), then hand off to Claude in FREE_NOW_MODE to
  // match them against other currently-free members.
  let freeNowMode = false;
  let freeUntilMs: number | undefined;
  if (!eventMode && !editMode) {
    const free = parseFreeCommand(body);
    if (free.matched) {
      freeNowMode = true;
      freeUntilMs = Date.now() + free.minutes * 60_000;
      await userRef.set(
        { freeUntil: Timestamp.fromMillis(freeUntilMs) },
        { merge: true }
      );
    }
  }

  const [history, members, upcomingEvents] = await Promise.all([
    loadConversation(db, uid),
    getMemberDirectory(db),
    getUpcomingEvents(db),
  ]);
  const enrichment = (userData.enrichment ?? {}) as Record<string, unknown>;

  // ── Buddy match (deterministic, headline feature) ──────────────────────────
  // `find me a buddy` short-circuits here — it never reaches the local model,
  // which would pick one semi-random person. We rank the directory by interest
  // similarity to the requester and surface the top few, each with a Connect
  // button, so the user chooses. (Free-now keeps its time-sensitive
  // FREE_NOW_MODE; topic browse + everything else still flow to the model.)
  if (isBuddyIntent(body) && !eventMode && !editMode && !freeNowMode) {
    let buddyReply: string;
    let buddyTelegramBody: string | undefined;
    let buddyButtons: OutboxButton[] | undefined;

    const ud = userData as Record<string, unknown>;
    if (!hasAnyInterest(ud, enrichment)) {
      // Nothing to match on — ask what they're into (Shah, Jun 9: "matching anyone").
      buddyReply = msg(lang).buddyAskInterest;
    } else {
      const selfTopics = selfTopicList(ud, enrichment);
      const selfQueryText = [
        ud.goal,
        enrichment.bio || ud.bio,
        selfTopics.join(", "),
        enrichment.matchSignals,
        enrichment.company,
        ud.lookingFor,
      ]
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join(" | ");
      const buddies = await rankBuddies(members, uid, selfQueryText, selfTopics, BUDDY_RESULTS);
      if (buddies.length === 0) {
        buddyReply = msg(lang).buddyNobodyYet;
      } else {
        // WhatsApp body keeps the typed nudge (no buttons); Telegram gets the
        // tap hint + a Connect button per buddy.
        buddyReply = buildBuddyReply(buddies, lang, msg(lang).introBrowseNudge);
        buddyTelegramBody = buildBuddyReply(buddies, lang, msg(lang).buddyTapHint);
        buddyButtons = buildBuddyButtons(buddies, lang);
      }
    }

    await writeOutbox(db, {
      provider,
      uid,
      phone,
      chatId,
      body: buddyReply,
      telegramBody: buddyTelegramBody,
      buttons: buddyButtons,
      type: "buddy",
    });
    await appendTurns(db, uid, [
      { role: "user", content: body, at: Timestamp.now() },
      { role: "assistant", content: buddyReply, at: Timestamp.now() },
    ]);
    await inboxDoc.ref.update({ intent: "buddy" });
    return;
  }

  // Pre-filter to the top-K members relevant to this requester+message so only a
  // small slice rides in the prompt (keeps throughput in the fast regime at
  // hundreds-1000 members). Falls back to all members for small communities.
  const relevantMembers = await selectRelevantMembers(members, uid, body, {
    goal: (userData as Record<string, unknown>).goal as string | undefined,
    topics: Array.isArray(enrichment.topics) ? (enrichment.topics as string[]) : undefined,
  });
  const directoryBlock = buildDirectoryBlock(relevantMembers);
  const eventsBlock = buildEventsBlock(upcomingEvents);
  // Past the yes/no fast-path the DB pending action is already cleared. We still
  // surface it to Claude so a free-text *amendment* ("actually make it 9pm"
  // after proposing an event) can re-emit the marker — but NOT when the new
  // message is itself a fresh recognized command (find me / who is here / create
  // event / …). In that case the stale block is pure noise and, on a borderline
  // query, derails the local model into the menu fallback (observed: "find me a
  // development" right after a climate-VC intro offer returned the help menu).
  const pendingForContext = pending && !isKnownIntent(body) ? pending : undefined;
  const volatileBlock = buildContextBlock({
    uid,
    provider,
    displayName,
    phone,
    self: {
      goal: (userData as Record<string, unknown>).goal as string | undefined,
      energy: (userData as Record<string, unknown>).energy as string | undefined,
      enrichedBio: enrichment.bio as string | undefined,
      enrichedTopics: Array.isArray(enrichment.topics)
        ? (enrichment.topics as string[])
        : undefined,
      enrichedCompany: enrichment.company as string | undefined,
      enrichedRecentActivity: enrichment.recentActivity as string | undefined,
      enrichedMatchSignals: enrichment.matchSignals as string | undefined,
      enrichmentStatus: enrichment.status as string | undefined,
    },
    history,
    pendingAction: pendingForContext,
    eventMode,
    editMode,
    editEvent:
      editMode && editEventId && editEventData
        ? {
            eventId: editEventId,
            title: String(editEventData.title ?? ""),
            kind: String(editEventData.kind ?? "other"),
            startAtISO:
              editEventData.startAt &&
              typeof (editEventData.startAt as Timestamp).toDate === "function"
                ? (editEventData.startAt as Timestamp).toDate().toISOString()
                : "",
            addressNeighborhood: String(editEventData.addressNeighborhood ?? ""),
            addressFull: String(editEventData.addressFull ?? ""),
            capacity:
              typeof editEventData.capacity === "number" ? editEventData.capacity : null,
          }
        : undefined,
    freeNowMode,
    freeUntilMs,
    lang,
  });

  // `find me a buddy` is handled by the deterministic short-circuit above, so it
  // never reaches here. Everything that does (topic browse, free-now, events,
  // edits, free text) goes to the local model.
  let rawReply: string;
  try {
    rawReply = await runClaude(
      claudeBody,
      directoryBlock,
      eventsBlock,
      volatileBlock,
      eventMode || editMode
    );
  } catch (e) {
    // In a guided mode an incomplete description (e.g. a title with no time/place)
    // makes the model correctly ask a follow-up with NO action marker — but
    // expectAction turns "no marker" into a thrown error, and local-only has no
    // fallback, so the turn would otherwise produce no reply at all (Shah, Jun 8:
    // "unable to create event" — "Create event" → "Cricket lovera" → silence).
    // Never go silent: ask for the missing details (or fall back to the menu).
    console.warn(
      `[bot] runClaude failed (eventMode=${eventMode} editMode=${editMode}):`,
      e instanceof Error ? e.message : e
    );
    if (eventMode) {
      if (eventTries >= 1) {
        // Already re-asked once and STILL no usable event — drop the wizard so a
        // non-event reply can't keep the user stuck looping (Shah, Jun 9).
        await setEventCreation(db, uid, null);
        rawReply = msg(lang).createEventGaveUp;
      } else {
        // Re-arm (the entry points cleared it just above) so the user's next,
        // hopefully complete, message is still treated as the description.
        await setEventCreation(db, uid, "awaiting_description", eventTries + 1);
        rawReply = msg(lang).createEventNeedMore;
      }
    } else if (editMode) {
      if (editEventId) await setEditEvent(db, uid, editEventId);
      rawReply = msg(lang).editNeedMore;
    } else {
      rawReply = msg(lang).menu;
    }
  }
  let { reply, action } = parseActionMarker(rawReply);

  // The eventId for an edit is authoritative from conversation state, not the
  // model. Stamp it on; and never let an edit_event marker survive outside an
  // actual edit turn (defends against a stray marker becoming a no-op pending).
  if (action?.kind === "edit_event") {
    if (editMode && editEventId) {
      action.eventId = editEventId;
    } else {
      action = null;
    }
  }

  // Backstop: a `find me <topic>` browse must never create a pending action. The
  // prompt forbids the marker here, but the local model is unreliable about it,
  // so if one slips through we drop it and replace any stray "Reply yes" with the
  // browse nudge — the intro stays the deliberate `intro me to <name>` step.
  if (action?.kind === "intro_buddy" && isTopicBrowse(body)) {
    action = null;
    const cleaned = stripYesCta(reply);
    // Only append the nudge if the model didn't already point them at the
    // `intro me to <name>` step (it often does even while wrongly emitting a
    // marker) — otherwise we'd double up the call-to-action.
    reply = /intro me to/i.test(cleaned)
      ? cleaned
      : `${cleaned}\n\n${msg(lang).introBrowseNudge}`.trim();
  }

  // No same-day events: a meetup must be scheduled for tomorrow (Paris) or later
  // so members have time to see the broadcast and RSVP. The prompt also asks for
  // this, but the local model is unreliable about dates, so enforce it here —
  // drop the marker and ask for a different day rather than create then reject.
  if (action?.kind === "create_event") {
    const startMs = Date.parse(action.startAtISO);
    if (
      Number.isNaN(startMs) ||
      parisDateKey(startMs) <= parisDateKey(Date.now())
    ) {
      action = null;
      reply = msg(lang).eventMustBeFuture;
    }
  }

  // Layer-2 hallucination backstop (runs after every other marker backstop, so
  // `action` here is the fully-validated set). A "Cancelled."/"Done." with no
  // real action behind it is a fabrication — replace it with the menu so a fake
  // success can never reach the user, on any model.
  reply = guardFabricatedSuccess(reply, !!action, lang);

  if (action) {
    await setPendingAction(db, uid, action);
  }

  await appendTurns(db, uid, [
    { role: "user", content: body, at: Timestamp.now() },
    { role: "assistant", content: reply, at: Timestamp.now() },
  ]);

  // Telegram tap-buttons. Three mutually-exclusive cases:
  //  • an action proposal → Yes/No confirm (ephemeral; the tapped token is still
  //    "yes"/"no" so the pendingAction fast-path resolves it unchanged), dropping
  //    the now-redundant "Reply yes" text from the Telegram body;
  //  • a `find me <topic>` browse → a "🤝 Intro: <Name>" button per suggestion so
  //    the intro is one tap, not a typed `intro me to <name>` (persistent);
  //  • the fallback menu → a few quick-action buttons (persistent).
  // WhatsApp (Twilio) ignores buttons and keeps the typed CTA in the body.
  let buttons: OutboxButton[] | undefined;
  let telegramBody: string | undefined;
  let ephemeralKeyboard = false;
  if (action) {
    const yesLabel =
      action.kind === "create_event"
        ? msg(lang).btn.yesCreate
        : action.kind === "edit_event"
          ? msg(lang).btn.yesEdit
          : action.kind === "share_founder_contact"
            ? msg(lang).btn.yesShare
            : msg(lang).btn.yesPing;
    buttons = [
      { text: yesLabel, data: "yes" },
      { text: msg(lang).btn.no, data: "no" },
    ];
    telegramBody = stripYesCta(reply);
    ephemeralKeyboard = true;
  } else if (isTopicBrowse(body)) {
    const introButtons = buildIntroButtons(reply, relevantMembers, lang, introTopicFrom(body));
    if (introButtons.length > 0) {
      buttons = introButtons;
      telegramBody = stripIntroNudge(reply); // WhatsApp body keeps the typed nudge
    }
  } else if (isMenuReply(reply, lang)) {
    buttons = menuButtons(lang);
  }

  await writeOutbox(db, {
    provider,
    uid,
    phone,
    chatId,
    body: reply,
    telegramBody,
    buttons,
    ephemeralKeyboard,
    type: action ? "action_proposed" : "bot_reply",
  });

  await inboxDoc.ref.update({
    intent: action ? `action_proposed:${action.kind}` : "claude_reply",
  });
}
