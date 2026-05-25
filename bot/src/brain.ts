/**
 * Bot brain — spawns the Claude Code CLI (`claude -p`) per inbound message
 * and pipes the reply into whatsappOutbox.
 *
 * The CLI inherits cwd = bot/, so it auto-loads bot/CLAUDE.md as its system prompt.
 * Per-call we append user-specific context (uid, phone, last few turns) via
 * --append-system-prompt. Auth comes from the local `claude login` session
 * stored in ~/.claude/ — no ANTHROPIC_API_KEY required.
 */

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type Anthropic from "@anthropic-ai/sdk";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 60_000);
const MAX_REPLY_CHARS = 1200;
const HISTORY_LIMIT = 6;

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

interface ConversationState {
  phone: string;
  uid: string;
  turns?: Turn[];
}

async function loadConversation(db: Firestore, phone: string): Promise<Turn[]> {
  const snap = await db.doc(`conversationStates/${phone}`).get();
  const data = snap.data() as ConversationState | undefined;
  return (data?.turns ?? []).slice(-HISTORY_LIMIT);
}

async function appendTurns(
  db: Firestore,
  phone: string,
  uid: string,
  newTurns: Turn[]
): Promise<void> {
  const ref = db.doc(`conversationStates/${phone}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = (snap.data()?.turns ?? []) as Turn[];
    const next = [...prev, ...newTurns].slice(-(HISTORY_LIMIT * 2));
    tx.set(
      ref,
      { phone, uid, turns: next, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
}

function buildContextBlock(args: {
  uid: string;
  phone: string;
  displayName?: string;
  history: Turn[];
}): string {
  const lines: string[] = [];
  lines.push(`# Current conversation context`);
  lines.push(`User uid: ${args.uid}`);
  lines.push(`User phone: ${args.phone}`);
  if (args.displayName) lines.push(`User display name: ${args.displayName}`);
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

export async function processMessage(deps: ProcessMessageDeps): Promise<void> {
  const { db, inboxDoc } = deps;
  const inbox = inboxDoc.data();
  const body = String(inbox.body ?? "").trim();
  const uid = String(inbox.uid);
  const phone = String(inbox.phone);

  if (!body) {
    await inboxDoc.ref.update({ intent: "empty" });
    return;
  }

  const userSnap = await db.doc(`users/${uid}`).get();
  const displayName = userSnap.data()?.displayName as string | undefined;

  const history = await loadConversation(db, phone);
  const contextBlock = buildContextBlock({ uid, phone, displayName, history });

  const reply = await runClaude(body, contextBlock);

  const now = Timestamp.now();
  await appendTurns(db, phone, uid, [
    { role: "user", content: body, at: now },
    { role: "assistant", content: reply, at: Timestamp.now() },
  ]);

  await db.collection("whatsappOutbox").add({
    recipientType: "individual",
    recipientPhone: phone,
    recipientUid: uid,
    type: "bot_reply",
    provider: "twilio",
    body: reply,
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
    scheduledFor: Timestamp.now(),
  });

  await inboxDoc.ref.update({ intent: "claude_reply" });
}
