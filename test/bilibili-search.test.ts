import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "../src/contracts.js";
import { normalizeSearchHit, parseBilibiliSearchResponse, searchBilibiliVideos } from "../src/bilibili-search.js";
import { DISCOVERY_LIMITS, DiscoveryError } from "../src/discovery-contracts.js";

const ID = "BV1164y1d7VF", CANONICAL = `https://www.bilibili.com/video/${ID}/`;
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "video", bvid: ID, arcurl: "http://www.bilibili.com/video/av758187705", title: "Efficient Transformer", author: "Example author", duration: "19:24", description: "Original source description", ...overrides };
}
function payload(result: unknown[] = [row()], metadata: Record<string, unknown> = {}) { return { code: 0, data: { result, ...metadata } }; }
function context(milliseconds = 2000, signal = new AbortController().signal): ExecutionContext { return { signal, deadlineMs: Date.now() + milliseconds }; }
function hasCode(code: string) { return (error: unknown) => error instanceof DiscoveryError && error.code === code; }
const bytes = (text: string) => new TextEncoder().encode(text);

test("raw search rows become plain source metadata without interpreting HTML or claiming a selected part", () => {
  const hit = normalizeSearchHit(row({ title: '<em class="keyword">Attention</em> &amp; &#20013;&#x6587; &quot;机制&quot;\u0000', author: "A&nbsp;B\u202e", description: "&lt;script&gt;secret&lt;/script&gt;<b>Useful</b>\ntext &amp; limits" }), 13);
  assert.deepEqual(hit, { video_id: ID, part_number: null, canonical_url: CANONICAL, title: 'Attention & 中文 "机制"', author: "A B", duration_seconds: 1164, snippet: "Useful text & limits", rank: 13 });
});

test("duration parsing accepts real unpadded search values and rejects absent, malformed or unsafe times", () => {
  for (const [input, expected] of [["12:5", 725], ["38:4", 2284], ["1:02:3", 3723], ["75:00", 4500], [125.5, 125.5], ["00:00", null], ["1:60", null], ["1:60:00", null], ["1:2:3:4", null], ["125", null], [undefined, null], ["unknown", null], [-1, null], [Infinity, null], ["999999999999999999:00", null]] as const) {
    assert.equal(normalizeSearchHit(row({ duration: input }), 1)?.duration_seconds, expected, String(input));
  }
});

test("large unfinished markup is scanned without retaining script or comment contents", () => {
  const hit = normalizeSearchHit(row({ title: "Safe title", description: "<script>".repeat(20_000) + "hidden source tail" }), 1);
  assert.equal(hit?.title, "Safe title"); assert.equal(hit?.snippet, null);
  assert.equal(normalizeSearchHit(row({ description: "<!--".repeat(20_000) + "hidden source tail" }), 1)?.snippet, null);
  assert.equal(normalizeSearchHit(row({ title: "A < B and B > C" }), 1)?.title, "A < B and B > C");
});

test("canonical links retain explicitly selected parts, strip tracking and revalidate normalized hits", () => {
  for (const part of [1, 17]) {
    const hit = normalizeSearchHit(row({ arcurl: `http://m.bilibili.com/video/${ID}?p=0${part}&share_source=private#fragment` }), 3);
    assert.equal(hit?.part_number, part); assert.equal(hit?.canonical_url, `${CANONICAL}?p=${part}`);
    assert.deepEqual(normalizeSearchHit(hit, 3), hit);
  }
  const hit = normalizeSearchHit(row({ arcurl: `https://bilibili.com/video/${ID}/?share_source=private` }), 2);
  assert.equal(hit?.part_number, null); assert.equal(hit?.canonical_url, CANONICAL);
  const bounded = normalizeSearchHit(row({ title: "x".repeat(700), author: "y".repeat(300), description: "z".repeat(3000) }), 1)!;
  assert.equal(bounded.title.length, 500); assert.equal(bounded.author?.length, 200); assert.equal(bounded.snippet?.length, 2000);
  assert.deepEqual(normalizeSearchHit(bounded, 1), bounded);
});

test("unsafe or inconsistent video identities and selected-part links are discarded", () => {
  const invalid = [
    row({ type: "media_bangumi" }), row({ bvid: "av123" }), row({ title: "<script>only script</script>" }),
    row({ arcurl: "https://example.test/video/BV1164y1d7VF/" }), row({ arcurl: `https://secret:credential@www.bilibili.com/video/${ID}/` }),
    row({ arcurl: `https://www.bilibili.com:8443/video/${ID}/` }), row({ arcurl: `ftp://www.bilibili.com/video/${ID}/` }),
    row({ arcurl: "https://www.bilibili.com/video/BV11f42117GE/" }), row({ arcurl: "https://www.bilibili.com/space/123" }),
    row({ arcurl: `${CANONICAL}?p=0` }), row({ arcurl: `${CANONICAL}?p=-1` }), row({ arcurl: `${CANONICAL}?p=word` }),
    row({ arcurl: `${CANONICAL}?p=1&p=17` }), row({ arcurl: `${CANONICAL}?p=9007199254740992` }),
    { ...normalizeSearchHit(row(), 1), part_number: 17 }, { ...normalizeSearchHit(row(), 1), canonical_url: `${CANONICAL}?p=17` },
  ];
  for (const value of invalid) assert.equal(normalizeSearchHit(value, 1), null);
  assert.equal(normalizeSearchHit(row(), 0), null); assert.equal(normalizeSearchHit(row(), 1.5), null); assert.equal(normalizeSearchHit(row(), 21), null);
});

test("only an explicit successful result array can represent an empty search", () => {
  assert.deepEqual(parseBilibiliSearchResponse(payload([], { numResults: 0 })), { hits: [], rows_received: 0, rows_discarded: 0, has_more: false, warnings: [] });
  for (const value of [null, [], { code: "0", data: { result: [] } }, { code: 0 }, { code: 0, data: {} }, { code: 0, data: { result: null } }, { code: 0, data: { result: {} } }]) assert.throws(() => parseBilibiliSearchResponse(value), hasCode("SEARCH_INVALID_RESPONSE"));
  for (const page of [0, 2, "1", null, NaN]) assert.throws(() => parseBilibiliSearchResponse(payload([row()], { page })), hasCode("SEARCH_INVALID_RESPONSE"));
});

test("the page cap and invalid rows preserve original ranks and report every discarded row", () => {
  const rows = [row({ bvid: "bad" }), ...Array.from({ length: 22 }, (_, i) => row({ bvid: `BV${String(i).padStart(10, "0")}`, arcurl: undefined }))];
  const page = parseBilibiliSearchResponse(payload(rows, { page: 1, numPages: 3 }));
  assert.equal(page.rows_received, 23); assert.equal(page.rows_discarded, 4); assert.equal(page.hits.length, 19);
  assert.equal(page.hits[0].rank, 2); assert.equal(page.hits.at(-1)?.rank, 20); assert.equal(page.has_more, true);
  assert.equal(page.warnings.length, 2);
});

test("pagination distinguishes known continuation, a known final page and unknown totals", () => {
  for (const [metadata, expected] of [[{ page: 1, numPages: 3 }, true], [{ page: 1, numPages: 1 }, false], [{ numResults: 45 }, true], [{ numResults: 20 }, false], [{}, null]] as const) assert.equal(parseBilibiliSearchResponse(payload([row()], metadata)).has_more, expected);
});

test("API failures classify access restrictions without exposing upstream message or challenge data", () => {
  for (const [code, expected] of [[-101, "SEARCH_AUTH_REQUIRED"], [-403, "SEARCH_BLOCKED"], [-412, "SEARCH_BLOCKED"], [-352, "SEARCH_BLOCKED"], [-509, "SEARCH_RATE_LIMITED"], [-400, "SEARCH_UPSTREAM_ERROR"]] as const) {
    assert.throws(() => parseBilibiliSearchResponse({ code, message: "private-token=secret-value", data: { challenge_url: "https://example.test/?signature=private" } }), (error: unknown) => {
      assert.ok(error instanceof DiscoveryError); assert.equal(error.code, expected); assert.doesNotMatch(error.message, /private|secret|signature/); return true;
    });
  }
});

test("one anonymous search request has fixed page and ordering, with no cookie, redirect or retry", async (t) => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init }); return new Response(JSON.stringify(payload([row()], { page: 1, numPages: 2 })));
  });
  const result = await searchBilibiliVideos("Linformer 自注意力", context());
  assert.equal(calls.length, 1); const { url, init } = calls[0];
  assert.equal(url.origin, "https://api.bilibili.com"); assert.equal(url.pathname, "/x/web-interface/search/type");
  assert.deepEqual(Object.fromEntries(url.searchParams), { search_type: "video", keyword: "Linformer 自注意力", page: "1", order: "totalrank", page_size: "20" });
  assert.equal(init?.redirect, "manual"); assert.equal(init?.credentials, "omit"); assert.equal(new Headers(init?.headers).get("cookie"), null);
  assert.equal(result.hits[0].canonical_url, CANONICAL); assert.equal(result.has_more, true);
});

test("HTTP restrictions are classified before parsing HTML, and rejected bodies are cancelled", async (t) => {
  for (const [status, expected] of [[401, "SEARCH_AUTH_REQUIRED"], [403, "SEARCH_BLOCKED"], [412, "SEARCH_BLOCKED"], [429, "SEARCH_RATE_LIMITED"], [302, "SEARCH_UPSTREAM_ERROR"], [503, "SEARCH_UPSTREAM_ERROR"]] as const) await t.test(String(status), async (t) => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes("<html>private-token=secret</html>")); }, cancel() { cancelled = true; } }), { status, headers: { "content-type": "text/html", location: "https://untrusted.test/redirect" } });
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(searchBilibiliVideos("query", context()), (error: unknown) => { assert.ok(error instanceof DiscoveryError); assert.equal(error.code, expected); assert.doesNotMatch(error.message, /private|secret|untrusted/); return true; });
    assert.equal(cancelled, true); assert.equal(fetch.mock.callCount(), 1);
  });
});

test("HTTP 200 HTML, invalid UTF-8 and empty bodies are format errors rather than empty results", async (t) => {
  for (const content of [bytes("<html>private login content</html>"), new Uint8Array([0xff]), new Uint8Array()]) {
    t.mock.method(globalThis, "fetch", async () => new Response(content));
    await assert.rejects(searchBilibiliVideos("query", context()), hasCode("SEARCH_INVALID_RESPONSE"));
    t.mock.restoreAll();
  }
});

test("oversized advertised bodies are cancelled without opening a response reader", async (t) => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-length": String(DISCOVERY_LIMITS.maxResponseBytes + 1) } });
  const reader = t.mock.method(response.body!, "getReader");
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(searchBilibiliVideos("query", context()), hasCode("SEARCH_RESPONSE_TOO_LARGE"));
  assert.equal(reader.mock.callCount(), 0); assert.equal(cancelled, true);
});

test("streamed byte limits apply without Content-Length, including the exact limit", async (t) => {
  const json = JSON.stringify(payload([])), padding = " ".repeat(DISCOVERY_LIMITS.maxResponseBytes - bytes(json).byteLength);
  t.mock.method(globalThis, "fetch", async () => new Response(json + padding));
  assert.equal((await searchBilibiliVideos("query", context())).hits.length, 0);
  t.mock.restoreAll();
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(DISCOVERY_LIMITS.maxResponseBytes)); controller.enqueue(bytes(" ")); }, cancel() { cancelled = true; } }));
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(searchBilibiliVideos("query", context()), hasCode("SEARCH_RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("expired or pre-cancelled requests do not start a fetch", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload([]))));
  await assert.rejects(searchBilibiliVideos("query", context(-1)), { name: "TimeoutError" });
  const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(searchBilibiliVideos("query", context(1000, controller.signal)), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("a deadline ends even a fetch dependency that ignores its AbortSignal", { timeout: 2000 }, async (t) => {
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}));
  await assert.rejects(searchBilibiliVideos("query", context(30)), { name: "TimeoutError" });
});

test("elapsed deadlines are checked even before a delayed event-loop timer can fire", async (t) => {
  const clock = Date.now.bind(Date); let offset = 0;
  const execution = context(1000);
  t.mock.method(Date, "now", () => clock() + offset);
  t.mock.method(globalThis, "fetch", async () => { offset = 2000; return new Response(JSON.stringify(payload([]))); });
  await assert.rejects(searchBilibiliVideos("query", execution), { name: "TimeoutError" });
});

test("a stalled response body obeys the deadline and cancels its reader", { timeout: 2000 }, async (t) => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes('{"code":0,"data":{"result":')); }, cancel() { cancelled = true; } }));
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(searchBilibiliVideos("query", context(30)), { name: "TimeoutError" });
  assert.equal(cancelled, true);
});

test("external cancellation interrupts a pending body without waiting for its deadline", { timeout: 2000 }, async (t) => {
  const controller = new AbortController(); let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  const timer = setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 30);
  try { await assert.rejects(searchBilibiliVideos("query", context(1000, controller.signal)), { name: "AbortError" }); }
  finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
});

test("network and stream failures return bounded diagnostics without upstream secrets or retries", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("https://example.test/?token=private-value"); });
  await assert.rejects(searchBilibiliVideos("query", context()), (error: unknown) => { assert.ok(error instanceof DiscoveryError); assert.equal(error.code, "SEARCH_UPSTREAM_ERROR"); assert.doesNotMatch(error.message, /private|token|example/); return true; });
  assert.equal(fetch.mock.callCount(), 1); t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("authorization=private-value")); } })));
  await assert.rejects(searchBilibiliVideos("query", context()), (error: unknown) => { assert.ok(error instanceof DiscoveryError); assert.equal(error.code, "SEARCH_UPSTREAM_ERROR"); assert.doesNotMatch(error.message, /private|authorization/); return true; });
});
