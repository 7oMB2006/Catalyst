import type { ExecutionContext } from "./contracts.js";
import { DISCOVERY_LIMITS, DiscoveryError, type SearchHit, type SearchPage } from "./discovery-contracts.js";

const SEARCH_ENDPOINT = "https://api.bilibili.com/x/web-interface/search/type";
const VIDEO_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com"]);
type ObjectData = Record<string, unknown>;
const object = (value: unknown): ObjectData | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : null;
const integer = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const videoId = (value: unknown): string | null => typeof value === "string" && /^BV[\da-z]{10}$/i.test(value) ? `BV${value.slice(2)}` : null;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", times: "×", divide: "÷", plusmn: "±",
};
function stripMarkup(value: string): string {
  const output: string[] = [];
  let cursor = 0, hidden: string | null = null;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) { if (!hidden) output.push(value.slice(cursor)); break; }
    if (!hidden) output.push(value.slice(cursor, start));
    if (value.startsWith("<!--", start)) {
      const end = value.indexOf("-->", start + 4);
      if (end < 0) break;
      cursor = end + 3; continue;
    }
    if (!/[a-z/]/i.test(value[start + 1] ?? "")) {
      if (!hidden) output.push("<");
      cursor = start + 1; continue;
    }
    const end = value.indexOf(">", start + 1);
    if (end < 0) break;
    const tag = value.slice(start + 1, end).match(/^(\/)?([a-z][\da-z:-]*)\b/i);
    if (tag) {
      const name = tag[2].toLowerCase();
      if (hidden) { if (tag[1] && name === hidden) hidden = null; }
      else {
        if (!tag[1] && ["script", "style"].includes(name)) hidden = name;
        output.push(" ");
      }
    } else if (!hidden) output.push(value.slice(start, end + 1));
    cursor = end + 1;
  }
  return output.join("");
}
function plainText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  let decoded = value;
  // Decode bounded layers before stripping tags, including encoded markup. Never evaluate HTML.
  for (let pass = 0; pass < 2; pass++) decoded = decoded.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
    if (name.startsWith("#")) {
      const point = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : " ";
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
  let text = stripMarkup(decoded).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text || null;
}
function duration(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  if (typeof value !== "string" || !/^\d+(?::\d{1,2}){1,2}$/.test(value.trim())) return null;
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !integer(part, 0)) || parts.slice(1).some((part) => part > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return integer(seconds, 1) ? seconds : null;
}

/** Normalize raw API rows and revalidate injected SearchHit objects at the same trust boundary. */
export function normalizeSearchHit(value: unknown, rank: number): SearchHit | null {
  const row = object(value);
  if (!row || !integer(rank, 1) || rank > DISCOVERY_LIMITS.resultsPerQuery || (row.type !== undefined && row.type !== "video")) return null;
  const normalized = Object.hasOwn(row, "video_id"), id = videoId(normalized ? row.video_id : row.bvid);
  if (!id) return null;
  const rawUrl = normalized ? row.canonical_url : row.arcurl;
  let part: number | null = null;
  if (rawUrl !== undefined) {
    if (typeof rawUrl !== "string") return null;
    let url: URL;
    try { url = new URL(rawUrl); } catch { return null; }
    if (!["https:", "http:"].includes(url.protocol) || !VIDEO_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
    const pathId = url.pathname.match(/^\/video\/(BV[\da-z]{10}|av[1-9]\d*)\/?$/i)?.[1];
    if (!pathId || (/^BV/i.test(pathId) && videoId(pathId) !== id)) return null;
    const pages = url.searchParams.getAll("p");
    if (pages.length > 1) return null;
    if (pages.length) {
      if (!/^\d+$/.test(pages[0]) || !integer(Number(pages[0]), 1)) return null;
      part = Number(pages[0]);
    }
  } else if (normalized) return null;
  if (normalized && row.part_number !== undefined && row.part_number !== part) return null;
  const title = plainText(row.title, 500);
  if (!title) return null;
  return {
    video_id: id, part_number: part, canonical_url: `https://www.bilibili.com/video/${id}/${part === null ? "" : `?p=${part}`}`,
    title, author: plainText(row.author, 200), duration_seconds: duration(normalized ? row.duration_seconds : row.duration),
    snippet: plainText(normalized ? row.snippet : row.description, 2000), rank,
  };
}

function apiFailure(code: number): never {
  if (code === -101) throw new DiscoveryError("SEARCH_AUTH_REQUIRED", "Bilibili search requires an authorized session.");
  if ([-403, -412, -352].includes(code)) throw new DiscoveryError("SEARCH_BLOCKED", "Bilibili blocked the search request.");
  if (code === -509) throw new DiscoveryError("SEARCH_RATE_LIMITED", "Bilibili rate-limited the search request.");
  throw new DiscoveryError("SEARCH_UPSTREAM_ERROR", "Bilibili returned an unsuccessful search response.", true);
}
export function parseBilibiliSearchResponse(payload: unknown): SearchPage {
  const root = object(payload);
  if (!root || typeof root.code !== "number" || !Number.isInteger(root.code)) throw new DiscoveryError("SEARCH_INVALID_RESPONSE", "Bilibili search returned an invalid response envelope.");
  if (root.code !== 0) apiFailure(root.code);
  const data = object(root.data);
  if (!data || !Array.isArray(data.result)) throw new DiscoveryError("SEARCH_INVALID_RESPONSE", "Bilibili search did not return an explicit result array.");
  if (data.page !== undefined && data.page !== 1) throw new DiscoveryError("SEARCH_INVALID_RESPONSE", "Bilibili search returned a different or invalid result-page identity.");
  const rows = data.result, inspected = rows.slice(0, DISCOVERY_LIMITS.resultsPerQuery);
  const hits = inspected.flatMap((row, index) => { const hit = normalizeSearchHit(row, index + 1); return hit ? [hit] : []; });
  const warnings: string[] = [];
  if (rows.length > inspected.length) warnings.push("Bilibili returned more than 20 search rows; only the first 20 were inspected within the per-query limit.");
  if (hits.length < inspected.length) warnings.push("Some Bilibili search rows were discarded because their video identity, link or title was invalid.");
  let more: boolean | null = null;
  const page = integer(data.page, 1) ? data.page : 1;
  if (integer(data.numPages, 0) && data.numPages >= page) more = data.numPages > page;
  else if (data.numPages === 0 && rows.length === 0) more = false;
  else if (integer(data.numResults, 0) && data.numResults >= rows.length) more = data.numResults > page * DISCOVERY_LIMITS.resultsPerQuery;
  return { hits, rows_received: rows.length, rows_discarded: rows.length - hits.length, has_more: more, warnings };
}

async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); signal.throwIfAborted(); }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason ?? new DOMException("Bilibili search cancelled.", "AbortError"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (listener) signal.removeEventListener("abort", listener); }
}
async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > DISCOVERY_LIMITS.maxResponseBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new DiscoveryError("SEARCH_RESPONSE_TOO_LARGE", "Bilibili search exceeded its response-byte limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await withSignal(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > DISCOVERY_LIMITS.maxResponseBytes) throw new DiscoveryError("SEARCH_RESPONSE_TOO_LARGE", "Bilibili search exceeded its response-byte limit.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Cancellation may still be settling an outstanding read. */ }
  }
}

/** One anonymous page, with no redirects, cookies, signatures, retries or media work. */
export async function searchBilibiliVideos(query: string, context: ExecutionContext): Promise<SearchPage> {
  context.signal.throwIfAborted();
  const remaining = context.deadlineMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new DOMException("Bilibili search deadline exceeded.", "TimeoutError");
  const timerController = new AbortController(), timer = setTimeout(() => timerController.abort(new DOMException("Bilibili search deadline exceeded.", "TimeoutError")), Math.min(Math.ceil(remaining), 2_147_483_647));
  const signal = AbortSignal.any([context.signal, timerController.signal]);
  const url = new URL(SEARCH_ENDPOINT);
  url.search = new URLSearchParams({ search_type: "video", keyword: query, page: "1", order: "totalrank", page_size: "20" }).toString();
  try {
    const response = await withSignal(fetch(url, { signal, redirect: "manual", credentials: "omit", headers: { "User-Agent": "Catalyst/0.1", Referer: "https://search.bilibili.com/", Accept: "application/json" } }).then((value) => {
      if (signal.aborted) void value.body?.cancel().catch(() => undefined);
      return value;
    }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if ([403, 412].includes(response.status)) throw new DiscoveryError("SEARCH_BLOCKED", "Bilibili blocked the search request.");
      if (response.status === 429) throw new DiscoveryError("SEARCH_RATE_LIMITED", "Bilibili rate-limited the search request.");
      if (response.status === 401) throw new DiscoveryError("SEARCH_AUTH_REQUIRED", "Bilibili search requires an authorized session.");
      throw new DiscoveryError("SEARCH_UPSTREAM_ERROR", `Bilibili search returned HTTP ${response.status}.`, response.status >= 500);
    }
    const bytes = await readBody(response, signal);
    if (Date.now() >= context.deadlineMs) timerController.abort(new DOMException("Bilibili search deadline exceeded.", "TimeoutError"));
    signal.throwIfAborted();
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new DiscoveryError("SEARCH_INVALID_RESPONSE", "Bilibili search did not return valid UTF-8 JSON."); }
    const page = parseBilibiliSearchResponse(payload);
    if (Date.now() >= context.deadlineMs) timerController.abort(new DOMException("Bilibili search deadline exceeded.", "TimeoutError"));
    signal.throwIfAborted();
    return page;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError("SEARCH_UPSTREAM_ERROR", "The Bilibili search request or response stream failed.", true);
  } finally { clearTimeout(timer); }
}
