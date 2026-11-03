import { z } from "zod";

export const discoveryRequestSchema = z.strictObject({
  question: z.string().trim().min(3).max(2000),
  queries: z.array(z.string().transform((s) => s.normalize("NFKC").trim().replace(/\s+/g, " ")).pipe(z.string().min(2).max(200).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)))).min(1).max(3).optional(),
  maxCandidates: z.number().int().min(1).max(20).default(10),
  timeoutSeconds: z.number().min(1).max(120).default(30),
}).refine((r) => {
  const query = r.question.normalize("NFKC").replace(/\s+/g, " ");
  return r.queries !== undefined || (query.length <= 200 && !/[\u0000-\u001f\u007f]/.test(query));
}, { message: "Supply explicit short queries when the question is not a valid search query." });

const failure = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() });
export const discoveryResultShape = {
  schema_version: z.literal("1.0"), status: z.enum(["complete", "partial", "unavailable"]), platform: z.literal("bilibili"),
  question: z.string(), search_exhaustive: z.literal(false),
  queries: z.array(z.object({
    id: z.string(), query: z.string(), status: z.enum(["complete", "empty", "failed", "not_run"]),
    requests_started: z.number().int().min(0).max(1), pages_received: z.number().int().min(0).max(1),
    rows_received: z.number().int().nonnegative(), rows_discarded: z.number().int().nonnegative(), has_more: z.boolean().nullable(), error: failure.nullable(),
  })).max(3),
  candidates: z.array(z.object({
    id: z.string(), platform: z.literal("bilibili"), content_type: z.literal("video"),
    video_id: z.string(), part_number: z.number().int().positive().nullable(), canonical_url: z.string().url(),
    title: z.string(), author: z.string().nullable(), duration_seconds: z.number().positive().nullable(), snippet: z.string().nullable(),
    content_status: z.literal("not_read"), media_access: z.literal("not_checked"), duration_basis: z.literal("search_metadata"),
    occurrences: z.array(z.object({ query_id: z.string(), rank: z.number().int().min(1).max(20) })),
    ranking: z.object({ method: z.literal("reciprocal_rank_fusion"), k: z.literal(60), score: z.number().nonnegative(), basis: z.literal("search_metadata"), reason: z.string() }),
  })).max(20),
  stop_reason: z.enum(["completed", "deadline", "cancelled", "blocked", "auth_required", "rate_limited", "error"]),
  limits: z.object({ max_queries: z.literal(3), pages_per_query: z.literal(1), results_per_query: z.literal(20), max_candidates: z.number().int().min(1).max(20), timeout_seconds: z.number().min(1).max(120), max_response_bytes: z.number().int().positive() }),
  processing: z.object({ duration_ms: z.number().nonnegative(), queries_attempted: z.number().int().nonnegative(), candidates_received: z.number().int().nonnegative(), duplicates_merged: z.number().int().nonnegative(), candidates_omitted: z.number().int().nonnegative() }),
  warnings: z.array(z.string()), errors: z.array(failure.extend({ query_id: z.string().optional() })),
};
export const discoveryResultSchema = z.object(discoveryResultShape);
