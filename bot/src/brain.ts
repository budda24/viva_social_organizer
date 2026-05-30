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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnboardingStep, type UserDocLike } from "./onboarding.js";
import {
  acceptIntroRequest,
  declineIntroRequest,
  describePendingAction,
  executePendingAction,
  parseActionMarker,
  type OutboxButton,
  type PendingAction,
  type PendingIntroRequest,
} from "./actions.js";
import {
  claudeLanguageDirective,
  isNoWord,
  isYesWord,
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
}

interface ConvoState {
  turns?: Turn[];
  pendingAction?: PendingAction;
  pendingActionAt?: Timestamp;
  eventCreation?: EventCreationState;
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

const isYes = isYesWord;
const isNo = isNoWord;

// `create event`, `/event`, `new event`, `add event` (+ French: `créer
// événement`, `nouvel événement`, `événement`), optionally with an inline
// description. The optional rest is parsed as the description in the same turn.
//
// Plain English `event …` without create/new/add OR a leading slash is
// rejected so "the event went well" doesn't trigger the wizard.
const CREATE_EVENT_CMD_RE =
  /^\s*(?:\/[\w-]*event|(?:create|new|add)[\s_-]?event|(?:cr[ée]er|nouvel|nouvelle|ajouter)[\s_-]?[ée]v[ée]nement|[ée]v[ée]nement)\b[:\s-]*(.*)$/i;

function matchCreateEventCommand(text: string): { matched: boolean; rest: string } {
  const m = text.match(CREATE_EVENT_CMD_RE);
  if (!m) return { matched: false, rest: "" };
  return { matched: true, rest: m[1].trim() };
}

async function setEventCreation(
  db: Firestore,
  uid: string,
  step: "awaiting_description" | null
): Promise<void> {
  const ref = db.doc(`conversationStates/${uid}`);
  if (step) {
    await ref.set(
      {
        uid,
        eventCreation: {
          step,
          startedAt: Timestamp.now(),
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

function formatParisHHMM(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

interface DirectoryMember {
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

async function loadMemberDirectory(db: Firestore): Promise<DirectoryMember[]> {
  const snap = await db.collection("users").where("status", "==", "approved").get();
  return snap.docs
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
function isKnownIntent(body: string): boolean {
  const t = body.trim();
  if (/^\/?help\b/i.test(t)) return true;
  if (/^\/?stop\b/i.test(t)) return true;
  if (/\bfind me\b/i.test(t)) return true;
  if (/\bwho(?:'?s| is)?\s*(?:here|around)\b/i.test(t)) return true;
  if (/\bfree\s+(?:for|now)\b/i.test(t)) return true;
  if (/\b(?:create|new)\s+event\b/i.test(t) || /^\/event\b/i.test(t)) return true;
  // `join <event>` RSVP (text or Join-button token) — answer it even mid-onboarding
  // so a broadcast that lands before sign-up finishes isn't eaten as a profile answer.
  if (/^\/?(?:join|rejoindre|participer)\b[:\s-]*\S/i.test(t)) return true;
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
function isTopicBrowse(body: string): boolean {
  const t = body.trim();
  if (!/\bfind me\b/i.test(t)) return false;
  if (/\bfind\s+(?:me\s+)?(?:a\s+)?buddy\b/i.test(t)) return false;
  return true;
}

// Strip a trailing confirm-CTA the model tacks on (EN + FR): "…? Reply `yes`."
// (intro proposals) or "Confirm with yes …" (event proposals). Only the last
// sentence is touched (the `[^.!\n]*` can't cross prior sentence ends), so the
// suggestion itself is preserved. Two uses: the topic-browse backstop below, and
// producing the Telegram body where a Yes/No button replaces the text CTA.
const TRAILING_YES_CTA_RE =
  /\s*(?:[^.!\n]*?\?\s*)?(?:reply|r[ée]ponds?|confirm(?:\s+with)?|confirme(?:\s+avec)?)\s+[`'"]?(?:yes|oui)\b[`'"]?[^.!?\n]*[.!?]?\s*$/i;
function stripYesCta(reply: string): string {
  const stripped = reply.replace(TRAILING_YES_CTA_RE, "").trim();
  // If stripping ate everything (CTA was the whole reply), keep the original —
  // an empty Telegram body would be rejected by the send path.
  return stripped || reply;
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
async function ensureMemberEmbeddings(members: DirectoryMember[]): Promise<void> {
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
        hostName: String(e.hostName ?? ""),
        description: String(e.description ?? ""),
      };
    })
    .filter((e) => e.startAtMs > now) // future only (≤ EVENTS_TTL_MS staleness)
    .sort((a, b) => a.startAtMs - b.startAtMs)
    .slice(0, 15);
}

// In-process events cache — same stale-while-revalidate + single-flight pattern
// as the member directory, so a burst of messages triggers one Firestore read.
const EVENTS_TTL_MS = Number(process.env.EVENTS_TTL_MS ?? 30_000);
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
  const parts = [`- ${e.title}`, `· ${when} Paris`];
  const place = e.addressFull || e.addressNeighborhood;
  if (place) parts.push(`· ${place}`);
  if (e.hostName) parts.push(`· host: ${e.hostName}`);
  if (e.description) parts.push(`— ${e.description}`);
  return parts.join(" ");
}

// The upcoming-events block injected into the prompt. Empty case tells Claude to
// say so plainly + offer to create one (not invent events).
function buildEventsBlock(events: UpcomingEvent[]): string {
  if (events.length === 0) {
    return `## Upcoming events\n(none scheduled yet — if the user asks what's on, say there are no events yet and offer "create event")`;
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
  const { text } = await runChat({
    system: [BASE_SYSTEM_PROMPT, directoryBlock, eventsBlock, volatileBlock],
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
  if (isTelegram && args.buttons && args.buttons.length > 0) row.buttons = args.buttons;
  await db.collection("whatsappOutbox").add(row);
}

// `join <event>` / `rejoindre <event>` / `participer <event>` — RSVP. The arg is
// either an event id (the Join button's callback_data) or a title fragment (a
// user typing it). Requires a non-empty arg so a bare "join" doesn't match.
const JOIN_CMD_RE = /^\s*\/?(?:join|rejoindre|participer)\b[:\s-]*(.+)$/i;

async function handleJoin(
  db: Firestore,
  uid: string,
  arg: string,
  lang: Lang
): Promise<{ reply: string; joined: boolean }> {
  // 1. Exact event id — the Join button sends `join <eventId>`.
  const byId = await db.doc(`events/${arg}`).get();
  let eventId: string | undefined;
  let title: string | undefined;
  if (byId.exists && byId.data()?.status === "scheduled") {
    eventId = byId.id;
    title = String(byId.data()?.title ?? "");
  } else {
    // 2. Title match against scheduled future events — someone typed the name.
    const events = await getUpcomingEvents(db);
    const q = arg.toLowerCase();
    const matches = events.filter(
      (e) =>
        e.title.toLowerCase().includes(q) || q.includes(e.title.toLowerCase())
    );
    if (matches.length === 1) {
      eventId = matches[0].id;
      title = matches[0].title;
    } else if (matches.length === 0) {
      return { reply: msg(lang).rsvpNotFound, joined: false };
    } else {
      return { reply: msg(lang).rsvpAmbiguous, joined: false };
    }
  }

  await db
    .collection("events")
    .doc(eventId)
    .collection("rsvps")
    .doc(uid)
    .set(
      { uid, status: "going", via: "bot_join", at: FieldValue.serverTimestamp() },
      { merge: true }
    );
  return { reply: msg(lang).rsvpJoined(title || "the event"), joined: true };
}

export async function processMessage(deps: ProcessMessageDeps): Promise<void> {
  const { db, inboxDoc } = deps;
  const inbox = inboxDoc.data();
  const body = String(inbox.body ?? "").trim();
  const uid = String(inbox.uid);
  const provider = (inbox.provider as Provider) ?? "twilio";
  const phone = inbox.phone ? String(inbox.phone) : undefined;
  const chatId = inbox.chatId as number | undefined;

  if (!body) {
    await inboxDoc.ref.update({ intent: "empty" });
    return;
  }

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  const userData = (userSnap.data() ?? {}) as UserDocLike;
  const displayName = userData.displayName;
  const lang = normalizeLang(
    (userData as Record<string, unknown>).preferredLanguage
  );

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
  if (!isKnownIntent(body)) {
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
    if (isYes(body)) {
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
    if (isNo(body)) {
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
      await writeOutbox(db, {
        provider,
        uid,
        phone,
        chatId,
        body: result.reply,
        type: "action_confirm",
      });
      await appendTurns(db, uid, [
        { role: "user", content: body, at: Timestamp.now() },
        { role: "assistant", content: result.reply, at: Timestamp.now() },
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
  let eventMode = false;
  let claudeBody = body;

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
    await setEventCreation(db, uid, null);
  }

  // Free-now: write the user's availability window deterministically (Claude
  // has no tool to write it), then hand off to Claude in FREE_NOW_MODE to
  // match them against other currently-free members.
  let freeNowMode = false;
  let freeUntilMs: number | undefined;
  if (!eventMode) {
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
    freeNowMode,
    freeUntilMs,
    lang,
  });

  const rawReply = await runClaude(claudeBody, directoryBlock, eventsBlock, volatileBlock, eventMode);
  let { reply, action } = parseActionMarker(rawReply);

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

  if (action) {
    await setPendingAction(db, uid, action);
  }

  await appendTurns(db, uid, [
    { role: "user", content: body, at: Timestamp.now() },
    { role: "assistant", content: reply, at: Timestamp.now() },
  ]);

  // When Claude proposes an action, offer Yes/No tap-buttons on Telegram (the
  // tapped token is still "yes"/"no", so the pendingAction fast-path resolves it
  // unchanged) and drop the now-redundant "Reply yes" text from the Telegram body.
  let buttons: OutboxButton[] | undefined;
  let telegramBody: string | undefined;
  if (action) {
    const yesLabel =
      action.kind === "create_event" ? msg(lang).btn.yesCreate : msg(lang).btn.yesPing;
    buttons = [
      { text: yesLabel, data: "yes" },
      { text: msg(lang).btn.no, data: "no" },
    ];
    telegramBody = stripYesCta(reply);
  }

  await writeOutbox(db, {
    provider,
    uid,
    phone,
    chatId,
    body: reply,
    telegramBody,
    buttons,
    type: action ? "action_proposed" : "bot_reply",
  });

  await inboxDoc.ref.update({
    intent: action ? `action_proposed:${action.kind}` : "claude_reply",
  });
}
