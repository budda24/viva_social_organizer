/**
 * Bot brain — spawns the Claude Code CLI (`claude -p`) per inbound message
 * and pipes the reply into whatsappOutbox.
 *
 * The CLI inherits cwd = bot/, so it auto-loads bot/CLAUDE.md as its system prompt.
 * Per-call we append user-specific context (uid, provider, last few turns) via
 * --append-system-prompt. Auth comes from the local `claude login` session
 * stored in ~/.claude/ — no ANTHROPIC_API_KEY required.
 *
 * Channel-aware: reads `provider` from the inbox row and writes outbox rows
 * with the right recipient field (recipientPhone for twilio, recipientChatId
 * for telegram). Conversation history is keyed by uid so the same person
 * carries context across channels.
 */

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type Anthropic from "@anthropic-ai/sdk";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnboardingStep, type UserDocLike } from "./onboarding.js";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 60_000);
const MAX_REPLY_CHARS = 1200;
const HISTORY_LIMIT = 6;

type Provider = "twilio" | "telegram";

export interface ProcessMessageDeps {
  db: Firestore;
  anthropic: Anthropic;
  inboxDoc: QueryDocumentSnapshot;
  hostId: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  at: Timestamp;
}

async function loadConversation(db: Firestore, uid: string): Promise<Turn[]> {
  const snap = await db.doc(`conversationStates/${uid}`).get();
  const data = snap.data() as { turns?: Turn[] } | undefined;
  return (data?.turns ?? []).slice(-HISTORY_LIMIT);
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
}

async function loadMemberDirectory(
  db: Firestore,
  excludeUid: string
): Promise<DirectoryMember[]> {
  const snap = await db.collection("users").where("status", "==", "approved").get();
  return snap.docs
    .filter((d) => d.id !== excludeUid)
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
      };
    });
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
  return parts.join(" ");
}

function buildContextBlock(args: {
  uid: string;
  provider: Provider;
  displayName?: string;
  phone?: string;
  self: SelfContext;
  history: Turn[];
  members: DirectoryMember[];
}): string {
  const lines: string[] = [];
  lines.push(`# Current conversation context`);
  lines.push(`User uid: ${args.uid}`);
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

  if (args.members.length > 0) {
    lines.push(``);
    lines.push(`## Member directory (other approved members at VivaTech)`);
    for (const m of args.members) {
      lines.push(formatMemberLine(m));
    }
  } else {
    lines.push(``);
    lines.push(`## Member directory`);
    lines.push(`(empty — no other approved members yet; tell the user nobody else is here)`);
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

function runClaude(userMessage: string, contextBlock: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      userMessage,
      "--model",
      CLAUDE_MODEL,
      "--output-format",
      "text",
      "--append-system-prompt",
      contextBlock,
    ];
    const child = spawn(CLAUDE_BIN, args, {
      cwd: BOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${CLAUDE_BIN}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const reply = stdout.trim();
      if (!reply) {
        reject(new Error(`claude returned empty output. stderr: ${stderr.trim()}`));
        return;
      }
      resolve(reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) : reply);
    });
  });
}

async function writeOutbox(
  db: Firestore,
  args: { provider: Provider; uid: string; phone?: string; chatId?: number; body: string; type: string }
): Promise<void> {
  const row: Record<string, unknown> = {
    recipientType: "individual",
    recipientUid: args.uid,
    type: args.type,
    provider: args.provider,
    body: args.body,
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
    scheduledFor: Timestamp.now(),
  };
  if (args.provider === "twilio" && args.phone) row.recipientPhone = args.phone;
  if (args.provider === "telegram" && args.chatId !== undefined) row.recipientChatId = args.chatId;
  await db.collection("whatsappOutbox").add(row);
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

  // Onboarding gate — if the user hasn't completed the 3-question profile,
  // every inbound message is treated as an answer to the current question.
  // No Claude call until onboarding.step === "complete".
  const onboarding = await runOnboardingStep(userRef, userData, body);
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

  const [history, members] = await Promise.all([
    loadConversation(db, uid),
    loadMemberDirectory(db, uid),
  ]);
  const enrichment = (userData.enrichment ?? {}) as Record<string, unknown>;
  const contextBlock = buildContextBlock({
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
    members,
  });

  const reply = await runClaude(body, contextBlock);

  await appendTurns(db, uid, [
    { role: "user", content: body, at: Timestamp.now() },
    { role: "assistant", content: reply, at: Timestamp.now() },
  ]);

  await writeOutbox(db, {
    provider,
    uid,
    phone,
    chatId,
    body: reply,
    type: "bot_reply",
  });

  await inboxDoc.ref.update({ intent: "claude_reply" });
}
