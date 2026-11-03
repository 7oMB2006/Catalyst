import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "../src/contracts.js";
import { DiscoveryError, DISCOVERY_LIMITS, type DiscoveryRequest, type DiscoveryResult, type SearchHit, type SearchPage } from "../src/discovery-contracts.js";
import { discoverBilibiliVideos } from "../src/discovery.js";
import { discoveryResultSchema } from "../src/discovery-schema.js";

const QUESTION = "有哪些降低 Self-Attention 计算量的方法？";
const IDS = ["BV1DTxXzUEvW", "BV1xx411c7mD", "BV1Q541167Qg", "BV1bx411H7Vy"];

function hit(video = IDS[0], rank = 1, part: number | null = null): SearchHit {
  return {
    video_id: video, part_number: part,
    canonical_url: `https://www.bilibili.com/video/${video}/${part === null ? "" : `?p=${part}`}`,
    title: `Attention explanation ${video}${part === null ? "" : ` part ${part}`}`,
    author: "Fixture author", duration_seconds: 600,
    snippet: "Search metadata mentions query, key and sparse attention.", rank,
  };
}
function page(hits: SearchHit[] = [], extra: Partial<SearchPage> = {}): SearchPage {
  return { hits, rows_received: hits.length, rows_discarded: 0, has_more: false, warnings: [], ...extra };
}
function fixture(responses: Array<SearchPage | Error | ((context: ExecutionContext) => Promise<SearchPage>)> = [page([hit()])]) {
  const calls: Array<{ query: string; context: ExecutionContext }> = [];
  return {
    calls,
    dependencies: {
      search: async (query: string, context: ExecutionContext) => {
        const response = responses[calls.length]; calls.push({ query, context });
        assert.ok(response, "search cannot exceed the explicitly planned query budget");
        if (response instanceof Error) throw response;
        return typeof response === "function" ? response(context) : structuredClone(response);
      },
    },
  };
}
function assertContract(result: DiscoveryResult): void {
  assert.ok(discoveryResultSchema.safeParse(result).success, "all outcomes conform to the discoverable output schema");
  assert.equal(result.platform, "bilibili"); assert.equal(result.search_exhaustive, false);
  assert.ok(!("evidence" in result)); assert.ok(!("findings" in result)); assert.ok(!("analysis" in result));
  const queryIds = new Set(result.queries.map((query) => query.id));
  assert.equal(queryIds.size, result.queries.length);
  assert.equal(new Set(result.candidates.map((candidate) => candidate.id)).size, result.candidates.length);
  for (const candidate of result.candidates) {
    assert.equal(candidate.content_status, "not_read"); assert.equal(candidate.media_access, "not_checked");
    assert.equal(candidate.duration_basis, "search_metadata"); assert.equal(candidate.ranking.basis, "search_metadata");
    assert.equal(candidate.ranking.method, "reciprocal_rank_fusion"); assert.equal(candidate.ranking.k, 60);
    assert.ok(candidate.ranking.reason.trim());
    assert.ok(candidate.occurrences.every((occurrence) => queryIds.has(occurrence.query_id)));
  }
}

test("question-only discovery performs one bounded search and returns unread candidates without source/provider work", async () => {
  const next = fixture(), originalFetch = globalThis.fetch;
  let extraFetches = 0;
  globalThis.fetch = (async () => { extraFetches++; throw new Error("Discovery must not call a source or model outside its search dependency."); }) as typeof fetch;
  try {
    const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies);
    assert.equal(result.status, "complete"); assert.equal(result.stop_reason, "completed");
    assert.deepEqual(next.calls.map((call) => call.query), [QUESTION.normalize("NFKC")]); assert.equal(extraFetches, 0);
    assert.equal(next.calls[0].context.signal.aborted, false); assert.ok(Number.isFinite(next.calls[0].context.deadlineMs));
    assert.deepEqual(result.limits, { max_queries: 3, pages_per_query: 1, results_per_query: 20, max_candidates: 10, timeout_seconds: 30, max_response_bytes: DISCOVERY_LIMITS.maxResponseBytes });
    assert.equal(result.processing.queries_attempted, 1); assert.equal(result.queries[0].requests_started, 1);
    assert.equal(result.queries[0].pages_received, 1); assert.equal(result.queries[0].status, "complete");
    assert.equal(result.candidates[0].canonical_url, hit().canonical_url);
    assert.deepEqual(result.candidates[0].occurrences, [{ query_id: result.queries[0].id, rank: 1 }]);
    assertContract(result);
  } finally { globalThis.fetch = originalFetch; }
});

test("invalid questions, query counts and execution budgets fail before any search", async (t) => {
  const requests: Array<[string, unknown]> = [
    ["blank question", { question: "   " }], ["short question", { question: "ab" }],
    ["question over 2000", { question: "x".repeat(2001), queries: ["attention"] }],
    ["implicit query over 200", { question: "x".repeat(201) }],
    ["empty queries", { question: QUESTION, queries: [] }],
    ["too many queries", { question: QUESTION, queries: ["one", "two", "three", "four"] }],
    ["blank query", { question: QUESTION, queries: [" "] }],
    ["short query", { question: QUESTION, queries: ["a"] }],
    ["query over 200", { question: QUESTION, queries: ["x".repeat(201)] }],
    ["non-string query", { question: QUESTION, queries: [123] }],
    ["zero candidate budget", { question: QUESTION, maxCandidates: 0 }],
    ["candidate budget over 20", { question: QUESTION, maxCandidates: 21 }],
    ["fractional candidate budget", { question: QUESTION, maxCandidates: 1.5 }],
    ["zero timeout", { question: QUESTION, timeoutSeconds: 0 }],
    ["timeout over 120", { question: QUESTION, timeoutSeconds: 121 }],
    ["nonfinite timeout", { question: QUESTION, timeoutSeconds: Number.NaN }],
  ];
  for (const [label, request] of requests) await t.test(label, async () => {
    const next = fixture();
    const result = await discoverBilibiliVideos(request as DiscoveryRequest, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.ok(result.errors.some((error) => error.code === "INVALID_REQUEST"));
    assert.equal(next.calls.length, 0); assert.deepEqual(result.candidates, []);
  });
});

test("explicit bounded queries support a longer question without silently shortening its intent", async () => {
  const question = "Long research question: " + "attention constraints ".repeat(20), next = fixture([page()]);
  const result = await discoverBilibiliVideos({ question, queries: ["Linformer attention"] }, next.dependencies);
  assert.equal(result.status, "complete"); assert.equal(result.question, question.trim());
  assert.deepEqual(next.calls.map((call) => call.query), ["Linformer attention"]); assertContract(result);
});

test("queries normalize Unicode and whitespace and deduplicate case while retaining first-query spelling", async () => {
  const next = fixture([page(), page()]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["  Ｓｅｌｆ\tAttention   ", "self attention", "Sparse  attention"] }, next.dependencies);
  assert.equal(result.status, "complete");
  assert.deepEqual(next.calls.map((call) => call.query), ["Self Attention", "Sparse attention"]);
  assert.deepEqual(result.queries.map((query) => query.query), ["Self Attention", "Sparse attention"]);
  assert.equal(result.processing.queries_attempted, 2); assertContract(result);
});

test("rank fusion merges duplicate occurrences once per query, retains best original rank and uses stable ties", async () => {
  const next = fixture([
    page([hit(IDS[0], 4), hit(IDS[2], 2), hit(IDS[1], 3), hit(IDS[0], 1)], { has_more: true }),
    page([hit(IDS[1], 1), hit(IDS[3], 2), hit(IDS[0], 3)]),
  ]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["attention overview", "attention computation"], maxCandidates: 3 }, next.dependencies);
  assert.equal(result.status, "complete", "a candidate cap does not turn successful queries into a failure");
  assert.equal(result.stop_reason, "completed"); assert.equal(next.calls.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.video_id), [IDS[0], IDS[1], IDS[2]]);
  const first = result.candidates[0], second = result.candidates[1];
  assert.deepEqual(first.occurrences, [{ query_id: result.queries[0].id, rank: 1 }, { query_id: result.queries[1].id, rank: 3 }]);
  assert.ok(Math.abs(first.ranking.score - (1 / 61 + 1 / 63)) < 1e-12);
  assert.equal(first.ranking.score, second.ranking.score, "duplicate rows must not inflate reciprocal-rank scores");
  assert.equal(result.processing.candidates_received, 7); assert.equal(result.processing.duplicates_merged, 3); assert.equal(result.processing.candidates_omitted, 1);
  assert.equal(result.queries[0].has_more, true); assertContract(result);
});

test("an archive and explicitly selected first and seventeenth parts retain distinct candidate identities", async () => {
  const next = fixture([page([hit(IDS[0], 1), hit(IDS[0], 2, 1), hit(IDS[0], 3, 17)])]);
  const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies);
  assert.equal(result.status, "complete"); assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates.map((candidate) => candidate.part_number), [null, 1, 17]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.canonical_url), [hit().canonical_url, hit(IDS[0], 1, 1).canonical_url, hit(IDS[0], 1, 17).canonical_url]);
  assert.ok(result.candidates.every((candidate) => !("part_id" in candidate)), "a search result does not establish a CID");
  assertContract(result);
});

test("invalid candidate rows cannot introduce foreign identities, hostile URLs or invented source fields", async () => {
  const bad = [
    { ...hit(IDS[1], 2), canonical_url: `https://www.bilibili.com.evil.test/video/${IDS[1]}/` },
    { ...hit(IDS[1], 3), canonical_url: hit(IDS[2]).canonical_url },
    { ...hit(IDS[1], 4), part_number: 0 },
    { ...hit(IDS[1], 5), rank: 0 },
    { ...hit(IDS[1], 6), title: "   " },
    { ...hit(IDS[1], 7), rank: 21 },
  ];
  const next = fixture([page([hit(), ...bad])]);
  const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies);
  assert.equal(result.status, "partial"); assert.deepEqual(result.candidates.map((candidate) => candidate.video_id), [IDS[0]]);
  assert.ok(result.warnings.length > 0); assert.ok(result.queries[0].rows_discarded >= 1); assertContract(result);
});

test("upstream discarded rows and warnings retain valid original ranks and yield an explicit partial result", async () => {
  const next = fixture([page([hit(IDS[0], 3)], { rows_received: 3, rows_discarded: 2, has_more: null, warnings: ["Two malformed search rows were discarded."] })]);
  const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.queries[0].rows_received, 3); assert.equal(result.queries[0].rows_discarded, 2);
  assert.equal(result.candidates[0].occurrences[0].rank, 3); assert.ok(Math.abs(result.candidates[0].ranking.score - 1 / 63) < 1e-12);
  assert.ok(result.warnings.some((warning) => warning.includes("Two malformed"))); assertContract(result);
});

test("a successful empty page is an empty search, with no inferred access failure or exhaustive-search claim", async () => {
  const next = fixture([page()]);
  const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies);
  assert.equal(result.status, "complete"); assert.equal(result.stop_reason, "completed");
  assert.equal(result.queries[0].status, "empty"); assert.equal(result.queries[0].error, null);
  assert.deepEqual(result.candidates, []); assert.deepEqual(result.errors, []); assertContract(result);
});

test("a nonempty page containing only invalid rows cannot be presented as a successful empty search", async () => {
  const next = fixture([page([{ ...hit(), canonical_url: "https://untrusted.example/video/other" }])]);
  const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies);
  assert.equal(result.status, "unavailable"); assert.equal(result.queries[0].status, "failed");
  assert.equal(result.queries[0].pages_received, 1); assert.equal(result.queries[0].rows_received, 1);
  assert.equal(result.queries[0].error?.code, "SEARCH_INVALID_RESPONSE");
  assert.ok(result.errors.some((error) => error.code === "SEARCH_INVALID_RESPONSE"));
  assert.deepEqual(result.candidates, []); assertContract(result);
});

test("a nonfatal query failure preserves successful candidates and continues the next explicit query", async () => {
  const next = fixture([page([hit()]), new DiscoveryError("UPSTREAM_ERROR", "Fixture query failed", true), page([hit(IDS[1])])]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["one query", "two query", "three query"] }, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(next.calls.length, 3);
  assert.deepEqual(result.queries.map((query) => query.status), ["complete", "failed", "complete"]);
  assert.deepEqual(new Set(result.candidates.map((candidate) => candidate.video_id)), new Set([IDS[0], IDS[1]]));
  assert.ok(result.errors.some((error) => error.code === "UPSTREAM_ERROR" && error.query_id === result.queries[1].id));
  assert.equal(result.queries[1].error?.retryable, true); assertContract(result);
});

test("blocking, authentication and rate limits stop later queries without silently probing other access paths", async (t) => {
  for (const [code, reason] of [["SEARCH_BLOCKED", "blocked"], ["SEARCH_AUTH_REQUIRED", "auth_required"], ["SEARCH_RATE_LIMITED", "rate_limited"]] as const) await t.test(code, async () => {
    const next = fixture([new DiscoveryError(code, "Fixture platform restriction", false)]);
    const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["first query", "second query", "third query"] }, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.equal(result.stop_reason, reason); assert.equal(next.calls.length, 1);
    assert.deepEqual(result.queries.map((query) => query.status), ["failed", "not_run", "not_run"]);
    assert.deepEqual(result.queries.map((query) => query.requests_started), [1, 0, 0]);
    assert.ok(result.errors.some((error) => error.code === code)); assertContract(result);
  });
});

test("a fatal restriction after a successful query retains existing candidates as partial", async () => {
  const next = fixture([page([hit()]), new DiscoveryError("SEARCH_BLOCKED", "Fixture platform restriction")]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["first query", "second query", "third query"] }, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.stop_reason, "blocked"); assert.equal(next.calls.length, 2);
  assert.equal(result.candidates.length, 1); assert.equal(result.queries[2].status, "not_run"); assertContract(result);
});

test("all failed queries report unavailable rather than a successful empty search", async () => {
  const next = fixture([new DiscoveryError("UPSTREAM_ERROR", "First failure", true), new DiscoveryError("UPSTREAM_ERROR", "Second failure", true)]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["first query", "second query"] }, next.dependencies);
  assert.equal(result.status, "unavailable"); assert.equal(next.calls.length, 2); assert.equal(result.errors.length, 2);
  assert.ok(result.queries.every((query) => query.status === "failed")); assert.deepEqual(result.candidates, []); assertContract(result);
});

test("a pre-cancelled discovery makes no search request", async () => {
  const next = fixture(), controller = new AbortController(); controller.abort(new DOMException("Fixture cancellation", "AbortError"));
  const result = await discoverBilibiliVideos({ question: QUESTION }, next.dependencies, controller.signal);
  assert.equal(result.status, "unavailable"); assert.equal(result.stop_reason, "cancelled"); assert.equal(next.calls.length, 0);
  assert.equal(result.processing.queries_attempted, 0);
  assert.ok(result.queries.every((query) => query.status === "not_run" && query.requests_started === 0 && query.pages_received === 0)); assertContract(result);
});

test("external cancellation races a noncooperative search and retains prior candidates", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const next = fixture([page([hit()]), async () => { controller.abort(new DOMException("Fixture cancellation", "AbortError")); return new Promise<SearchPage>(() => {}); }]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["first query", "second query", "third query"] }, next.dependencies, controller.signal);
  assert.equal(result.status, "partial"); assert.equal(result.stop_reason, "cancelled"); assert.equal(next.calls.length, 2);
  assert.equal(result.candidates.length, 1); assert.equal(result.queries[2].status, "not_run");
  assert.ok(next.calls[1].context.signal.aborted); assertContract(result);
});

test("the shared deadline bounds a noncooperative search and preserves completed query results", { timeout: 5000 }, async () => {
  const next = fixture([page([hit()]), async () => new Promise<SearchPage>(() => {})]);
  const result = await discoverBilibiliVideos({ question: QUESTION, queries: ["first query", "second query", "third query"], timeoutSeconds: 1 }, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.stop_reason, "deadline"); assert.equal(next.calls.length, 2);
  assert.equal(result.candidates.length, 1); assert.equal(result.queries[2].status, "not_run");
  assert.equal(next.calls[0].context.deadlineMs, next.calls[1].context.deadlineMs, "later queries do not receive a fresh full timeout");
  assert.ok(next.calls[1].context.signal.aborted); assertContract(result);
});
