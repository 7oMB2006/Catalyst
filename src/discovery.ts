import { performance } from "node:perf_hooks";
import type { ExecutionContext } from "./contracts.js";
import { safeDiagnostic } from "./acquisition.js";
import { normalizeSearchHit, searchBilibiliVideos } from "./bilibili-search.js";
import { DISCOVERY_LIMITS, DiscoveryError, type DiscoveryCandidate, type DiscoveryDependencies, type DiscoveryFailure, type DiscoveryRequest, type DiscoveryResult, type SearchPage } from "./discovery-contracts.js";
import { discoveryRequestSchema } from "./discovery-schema.js";

async function bounded<T>(operation: () => Promise<T>, context: ExecutionContext): Promise<T> {
  context.signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    listener = () => reject(context.signal.reason ?? new DOMException("Discovery cancelled.", "AbortError"));
    context.signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), abort]); }
  finally { if (listener) context.signal.removeEventListener("abort", listener); }
}
function issue(error: unknown, context: ExecutionContext): DiscoveryFailure {
  if (context.signal.aborted) return { code: context.signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED", message: "Discovery was cancelled or its shared deadline expired.", retryable: true };
  const value = error as { code?: string; name?: string; message?: string; retryable?: boolean };
  if (value?.name === "TimeoutError" || value?.name === "AbortError") return { code: value.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED", message: "Discovery was cancelled or its shared deadline expired.", retryable: true };
  return { code: typeof value?.code === "string" ? value.code : "SEARCH_UPSTREAM_ERROR", message: safeDiagnostic(value?.message ?? "Search failed."), retryable: value?.retryable === true };
}
const stopping = { SEARCH_BLOCKED: "blocked", SEARCH_AUTH_REQUIRED: "auth_required", SEARCH_RATE_LIMITED: "rate_limited", TIMEOUT: "deadline", CANCELLED: "cancelled" } as const;

/** Candidate discovery never reads content or invokes a research/model/media pipeline. */
export async function discoverBilibiliVideos(request: DiscoveryRequest, overrides: Partial<DiscoveryDependencies> = {}, externalSignal?: AbortSignal): Promise<DiscoveryResult> {
  const at = performance.now(), parsed = discoveryRequestSchema.safeParse(request);
  const result: DiscoveryResult = {
    schema_version: "1.0", status: "unavailable", platform: "bilibili", question: typeof request?.question === "string" ? request.question.trim().slice(0, 2000) : "",
    queries: [], candidates: [], search_exhaustive: false, stop_reason: "error",
    limits: { max_queries: 3, pages_per_query: 1, results_per_query: 20, max_candidates: 10, timeout_seconds: 30, max_response_bytes: DISCOVERY_LIMITS.maxResponseBytes },
    processing: { duration_ms: 0, queries_attempted: 0, candidates_received: 0, duplicates_merged: 0, candidates_omitted: 0 },
    warnings: ["Search titles, snippets and ranks are untrusted discovery metadata, not read content or factual evidence. Media access has not been checked.", "Only the first result page of each explicit query is inspected. This is not exhaustive search; query planning and source selection belong to the host agent."], errors: [],
  };
  if (!parsed.success) {
    result.errors.push({ code: "INVALID_REQUEST", message: "Supply a question (3–2000 characters), one to three short queries (2–200 characters), max_candidates=1–20 and timeout_seconds=1–120. Questions over 200 characters require explicit queries.", retryable: false });
    result.processing.duration_ms = Math.round(performance.now() - at); return result;
  }
  const input = parsed.data;
  const distinct = new Map<string, string>();
  for (const query of input.queries ?? [input.question.normalize("NFKC").replace(/\s+/g, " ")]) if (!distinct.has(query.toLowerCase())) distinct.set(query.toLowerCase(), query);
  const queries = [...distinct.values()];
  result.question = input.question;
  result.limits.max_candidates = input.maxCandidates; result.limits.timeout_seconds = input.timeoutSeconds;
  result.queries = queries.map((query, index) => ({ id: `query:${index + 1}`, query, status: "not_run", requests_started: 0, pages_received: 0, rows_received: 0, rows_discarded: 0, has_more: null, error: null }));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException("Discovery deadline expired.", "TimeoutError")), input.timeoutSeconds * 1000);
  const context: ExecutionContext = { signal: externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal, deadlineMs: Date.now() + input.timeoutSeconds * 1000 };
  const search = overrides.search ?? searchBilibiliVideos, candidates = new Map<string, DiscoveryCandidate>();
  let succeeded = 0, firstSeen = 0;
  const order = new Map<string, number>();
  result.stop_reason = "completed";
  try {
    for (const query of result.queries) {
      try {
        context.signal.throwIfAborted();
        if (Date.now() >= context.deadlineMs) throw new DOMException("Discovery deadline expired.", "TimeoutError");
        query.requests_started = 1; result.processing.queries_attempted++;
        const page: SearchPage = await bounded(() => search(query.query, context), context);
        if (!page || !Array.isArray(page.hits) || !Array.isArray(page.warnings) || !page.warnings.every((w) => typeof w === "string") || !Number.isSafeInteger(page.rows_received) || page.rows_received < 0 || !Number.isSafeInteger(page.rows_discarded) || page.rows_discarded < 0 || page.rows_discarded > page.rows_received || (page.has_more !== null && typeof page.has_more !== "boolean")) throw new DiscoveryError("SEARCH_INVALID_RESPONSE", "Search returned an invalid result page.");
        query.pages_received = 1; query.rows_received = page.rows_received; query.rows_discarded = page.rows_discarded; query.has_more = page.has_more;
        result.warnings.push(...page.warnings.map((warning) => `${query.id}: ${safeDiagnostic(warning)}`));
        const unique = new Map<string, ReturnType<typeof normalizeSearchHit>>();
        for (const raw of page.hits.slice(0, DISCOVERY_LIMITS.resultsPerQuery)) {
          const hit = raw && typeof raw.rank === "number" ? normalizeSearchHit(raw, raw.rank) : null;
          if (!hit) { query.rows_discarded++; continue; }
          result.processing.candidates_received++;
          const id = `bilibili:${hit.video_id}:${hit.part_number === null ? "archive" : `p${hit.part_number}`}`;
          const previous = unique.get(id);
          if (previous) { result.processing.duplicates_merged++; if (hit.rank < previous.rank) unique.set(id, hit); }
          else unique.set(id, hit);
        }
        if (page.hits.length > DISCOVERY_LIMITS.resultsPerQuery) query.rows_discarded += page.hits.length - DISCOVERY_LIMITS.resultsPerQuery;
        if (!unique.size && query.rows_received > 0) throw new DiscoveryError("SEARCH_INVALID_RESPONSE", "Search returned rows but no valid video candidates; this is not an empty search result.");
        for (const [id, hit] of unique) {
          if (!hit) continue;
          const existing = candidates.get(id), occurrence = { query_id: query.id, rank: hit.rank };
          if (existing) {
            existing.occurrences.push(occurrence); existing.ranking.score += 1 / (60 + hit.rank); result.processing.duplicates_merged++;
          } else {
            const { rank: _rank, ...metadata } = hit;
            candidates.set(id, { ...metadata, id, platform: "bilibili", content_type: "video", content_status: "not_read", media_access: "not_checked", duration_basis: "search_metadata", occurrences: [occurrence], ranking: { method: "reciprocal_rank_fusion", k: 60, score: 1 / (60 + hit.rank), basis: "search_metadata", reason: "" } });
            order.set(id, firstSeen++);
          }
        }
        if (query.rows_discarded) result.warnings.push(`${query.id}: ${query.rows_discarded} invalid or out-of-budget result rows were discarded.`);
        query.status = unique.size ? "complete" : "empty";
        succeeded++;
      } catch (error) {
        const failure = issue(error, context); query.status = query.requests_started ? "failed" : "not_run"; query.error = failure; result.errors.push({ ...failure, query_id: query.id });
        const stop = stopping[failure.code as keyof typeof stopping];
        if (stop) { result.stop_reason = stop; break; }
      }
    }
  } finally { clearTimeout(timer); }
  const ranked = [...candidates.values()].sort((a, b) => b.ranking.score - a.ranking.score || order.get(a.id)! - order.get(b.id)!);
  for (const candidate of ranked) candidate.ranking.reason = `Returned by ${candidate.occurrences.map((o) => `${o.query_id} at rank ${o.rank}`).join(", ")}. RRF combines search positions only; it is not a semantic relevance or factual-confidence score.`;
  result.processing.candidates_omitted = Math.max(0, ranked.length - input.maxCandidates);
  result.candidates = ranked.slice(0, input.maxCandidates);
  if (result.processing.candidates_omitted) result.warnings.push(`${result.processing.candidates_omitted} unique candidates were omitted by max_candidates.`);
  result.status = succeeded ? (result.errors.length || result.queries.some((q) => q.status === "not_run" || q.rows_discarded) ? "partial" : "complete") : "unavailable";
  if (!succeeded && result.stop_reason === "completed") result.stop_reason = "error";
  result.warnings = [...new Set(result.warnings)]; result.processing.duration_ms = Math.round(performance.now() - at);
  return result;
}
