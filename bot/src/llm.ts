/**
 * LLM backend abstraction — local Ollama first, Anthropic as fallback.
 *
 * One place owns "which model answers": brain.ts and enrich.ts call the helpers
 * here instead of touching Anthropic directly. Local inference (a ~32B model on
 * the workstation's GPUs) has no rate limit and zero marginal cost; Anthropic
 * (Haiku 4.5) stays wired as an automatic safety net so a local hiccup never
 * drops a reply during a live tester window.
 *
 * Transport: Ollama's NATIVE /api/chat, not the OpenAI-compat shim — only the
 * native API lets us set `num_ctx` and `keep_alive` per request (the two knobs
 * that make or break this setup) and accept a JSON schema for structured output.
 * Plain `fetch` (global in Node 18.19+); no SDK dependency added.
 *
 * Backend selection via LLM_BACKEND:
 *   - "local-first" (default): try local, fall back to Anthropic on hard failure.
 *   - "local":                 local only, no fallback (a local outage → throw).
 *   - "anthropic":             skip local entirely (one-line rollback).
 */

import Anthropic from "@anthropic-ai/sdk";

export type Backend = "local" | "anthropic";
export type BackendMode = "local-first" | "local" | "anthropic";

export const LLM_BACKEND: BackendMode =
  (process.env.LLM_BACKEND as BackendMode) ?? "local-first";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const LOCAL_CHAT_MODEL = process.env.LOCAL_CHAT_MODEL ?? "qwen2.5:32b-instruct-q4_K_M";
const LOCAL_NUM_CTX = Number(process.env.LOCAL_NUM_CTX ?? 8192);
const LOCAL_TEMPERATURE = Number(process.env.LOCAL_TEMPERATURE ?? 0.2);
const LOCAL_TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS ?? 20_000);
// keep_alive: a duration string ("30m") OR an integer seconds / -1 (forever).
// Ollama only parses bare integers as numbers — "-1" as a string is rejected —
// so coerce integer-looking values to a number. A per-request keep_alive
// overrides the server's OLLAMA_KEEP_ALIVE default, so this must agree with it.
const OLLAMA_KEEP_ALIVE: string | number = parseKeepAlive(process.env.OLLAMA_KEEP_ALIVE ?? "30m");

function parseKeepAlive(v: string): string | number {
  return /^-?\d+$/.test(v.trim()) ? Number(v) : v;
}
const ANTHROPIC_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";
const LOCAL_EMBED_MODEL = process.env.LOCAL_EMBED_MODEL ?? "bge-m3";
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 30_000);

/** True when the local backend should be attempted at all. */
export function localEnabled(): boolean {
  return LLM_BACKEND === "local-first" || LLM_BACKEND === "local";
}

// Lazily constructed so a pure-local deployment never needs ANTHROPIC_API_KEY.
let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

export interface ChatOpts {
  /** System blocks, in order. Joined for local; kept as cached blocks for Anthropic. */
  system: string[];
  user: string;
  maxTokens: number;
  temperature?: number;
  stop?: string[];
  /**
   * When true, a local reply that contains no parseable action marker is treated
   * as a local failure and falls back to Anthropic. Use only where a marker is
   * mandatory (e.g. EVENT_CREATION_MODE) — most replies legitimately have none.
   */
  expectAction?: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  backend: Backend;
}

/**
 * Chat completion. Returns prose text (the caller parses any embedded action
 * marker). Honors LLM_BACKEND and falls back to Anthropic on hard local errors.
 */
export async function runChat(opts: ChatOpts): Promise<ChatResult> {
  const temperature = opts.temperature ?? LOCAL_TEMPERATURE;

  if (localEnabled()) {
    try {
      const text = await ollamaChat({
        system: opts.system.join("\n\n"),
        user: opts.user,
        maxTokens: opts.maxTokens,
        temperature,
        stop: opts.stop,
        timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
      });
      if (!text) throw new Error("ollama returned empty content");
      if (opts.expectAction && !hasValidActionMarker(text)) {
        throw new Error("ollama reply missing required action marker");
      }
      return { text, backend: "local" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (LLM_BACKEND === "local") throw err; // no fallback configured
      console.warn(`[llm] local failed, falling back to anthropic: ${message}`);
      // fall through to Anthropic
    }
  }

  const text = await anthropicChat(opts);
  return { text, backend: "anthropic" };
}

export interface StructuredOpts {
  system: string[];
  user: string;
  /** JSON schema object passed to Ollama's `format` for constrained output. */
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface StructuredResult<T> {
  data: T;
  backend: Backend;
}

/**
 * Structured (JSON) completion via Ollama's schema-constrained output. Local
 * only — there is no Anthropic fallback here; enrich.ts handles its own fallback
 * to the claude-CLI web-search path, which needs tools this abstraction lacks.
 * Throws on any failure so the caller can decide to fall back.
 */
export async function runStructured<T>(opts: StructuredOpts): Promise<StructuredResult<T>> {
  const raw = await ollamaChat({
    system: opts.system.join("\n\n"),
    user: opts.user,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature ?? 0.1,
    format: opts.schema,
    timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
  });
  if (!raw) throw new Error("ollama structured output was empty");
  let data: T;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    throw new Error(`ollama structured output was not valid JSON: ${raw.slice(0, 300)}`);
  }
  return { data, backend: "local" };
}

/**
 * Embed a batch of texts locally via Ollama. Used by the directory pre-filter to
 * rank members by semantic relevance to a query so only the top-K ride in the
 * prompt (the throughput bottleneck at event scale). Local-only, no fallback.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts, keep_alive: OLLAMA_KEEP_ALIVE }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama embed HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { embeddings?: number[][] };
  if (!json.embeddings || json.embeddings.length !== texts.length) {
    throw new Error(`ollama embed returned ${json.embeddings?.length ?? 0} vectors for ${texts.length} inputs`);
  }
  return json.embeddings;
}

// ── Ollama transport ────────────────────────────────────────────────────────

interface OllamaCallOpts {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  stop?: string[];
  format?: Record<string, unknown>;
  timeoutMs: number;
}

async function ollamaChat(o: OllamaCallOpts): Promise<string> {
  const body: Record<string, unknown> = {
    model: LOCAL_CHAT_MODEL,
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: o.user },
    ],
    stream: false,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: {
      num_ctx: LOCAL_NUM_CTX,
      temperature: o.temperature,
      num_predict: o.maxTokens,
      ...(o.stop && o.stop.length ? { stop: o.stop } : {}),
    },
  };
  if (o.format) body.format = o.format;

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    // Normalize transient connection/timeout errors to a stable, classifiable
    // message. index.ts's TRANSIENT_RE matches "ollama timeout"/"ollama
    // unreachable" so pure-local overload requeues (delay) instead of dropping.
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`ollama timeout after ${o.timeoutMs}ms`);
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`ollama unreachable: ${detail}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { message?: { content?: string } };
  return (json.message?.content ?? "").trim();
}

// ── Anthropic transport (fallback) ───────────────────────────────────────────

async function anthropicChat(opts: ChatOpts): Promise<string> {
  // Prompt caching: mark all but the last system block (the volatile per-request
  // block) as cacheable ephemeral prefixes — the static prompt + member directory
  // are byte-identical across users, so this preserves the ~10% read-cost economics
  // of the original brain call.
  const system = opts.system.map((text, i) =>
    i < opts.system.length - 1
      ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text }
  );

  const result = await anthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    system,
    messages: [{ role: "user", content: opts.user }],
    ...(opts.stop && opts.stop.length ? { stop_sequences: opts.stop } : {}),
  });

  let text = "";
  for (const block of result.content) {
    if (block.type === "text") text += block.text;
  }
  text = text.trim();
  if (!text) throw new Error("anthropic returned no text content");
  return text;
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Lightweight check that a reply carries a parseable action marker with a `kind`.
 * Deliberately decoupled from actions.ts's full validator — brain.ts re-validates
 * downstream; this only needs to gate the expectAction fallback.
 */
function hasValidActionMarker(text: string): boolean {
  const m = text.match(/<<<ACTION\s*([\s\S]+?)\s*ACTION>>>/);
  if (!m) return false;
  try {
    const parsed = JSON.parse(m[1]) as { kind?: unknown };
    return typeof parsed.kind === "string" && parsed.kind.length > 0;
  } catch {
    return false;
  }
}
