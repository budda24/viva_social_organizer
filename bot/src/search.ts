/**
 * Self-hosted web search + page fetching for local enrichment.
 *
 * Replaces Anthropic's server-side WebSearch/WebFetch (which a local model can't
 * use) with a SearXNG JSON query plus plain `fetch` page retrieval. No paid APIs,
 * no heavy HTML deps — a regex strip is enough to feed an LLM.
 *
 * SearXNG must have JSON output enabled (`search.formats: [html, json]` in
 * settings.yml) — it's off by default and returns 403 otherwise.
 */

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 10_000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_PAGE_TIMEOUT_MS ?? 8_000);
const MAX_PAGE_BYTES = Number(process.env.FETCH_MAX_BYTES ?? 512 * 1024);
const MAX_PAGE_CHARS = Number(process.env.FETCH_MAX_CHARS ?? 2_000);

export interface SearchHit {
  title: string;
  url: string;
  /** SearXNG result snippet — a usable fallback when the page itself is walled. */
  content: string;
}

/**
 * Query SearXNG and return up to `topN` hits, ordered with linkedin.com and the
 * caller-supplied `preferHost` (typically the email domain) floated to the top —
 * those anchor identity best.
 */
export async function searchWeb(
  query: string,
  topN: number,
  preferHost?: string
): Promise<SearchHit[]> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`searxng HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const hits: SearchHit[] = (json.results ?? [])
    .map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      content: String(r.content ?? ""),
    }))
    .filter((h) => h.url.startsWith("http"));

  const rank = (h: SearchHit): number => {
    const u = h.url.toLowerCase();
    if (u.includes("linkedin.com")) return 0;
    if (preferHost && u.includes(preferHost.toLowerCase())) return 1;
    return 2;
  };
  hits.sort((a, b) => rank(a) - rank(b));
  return hits.slice(0, topN);
}

/**
 * Fetch a page and reduce it to plain text. Returns "" on any error/timeout so a
 * single dead link never sinks the whole enrichment — the caller falls back to
 * the SearXNG snippet for that hit.
 */
export async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // A real UA reduces (not eliminates) login-wall / bot-block responses.
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (!res.ok) return "";
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/html") && !ctype.includes("text/plain")) return "";
    const buf = await res.arrayBuffer();
    const html = Buffer.from(buf.slice(0, MAX_PAGE_BYTES)).toString("utf8");
    return htmlToText(html);
  } catch {
    return "";
  }
}

/**
 * Crude HTML → text: drop script/style/noscript, strip tags, decode a handful of
 * common entities, collapse whitespace, truncate. Good enough for LLM input; not
 * a parser. No cheerio/jsdom on purpose (keep the dependency footprint tiny).
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
}
