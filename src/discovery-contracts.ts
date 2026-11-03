import type { ExecutionContext } from "./contracts.js";

export const DISCOVERY_LIMITS = { maxQueries: 3, resultsPerQuery: 20, maxCandidates: 20, maxResponseBytes: 1024 * 1024 } as const;
export interface DiscoveryRequest {
  question: string;
  queries?: string[];
  maxCandidates?: number;
  timeoutSeconds?: number;
}
export interface SearchHit {
  video_id: string;
  part_number: number | null;
  canonical_url: string;
  title: string;
  author: string | null;
  duration_seconds: number | null;
  snippet: string | null;
  /** Original position on the platform result page, including discarded rows. */
  rank: number;
}
export interface SearchPage {
  hits: SearchHit[];
  rows_received: number;
  rows_discarded: number;
  has_more: boolean | null;
  warnings: string[];
}
export interface DiscoveryDependencies {
  search(query: string, context: ExecutionContext): Promise<SearchPage>;
}
export class DiscoveryError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); this.name = "DiscoveryError"; }
}
export interface DiscoveryFailure { code: string; message: string; retryable: boolean }
export interface DiscoveryQuery {
  id: string;
  query: string;
  status: "complete" | "empty" | "failed" | "not_run";
  requests_started: number;
  pages_received: number;
  rows_received: number;
  rows_discarded: number;
  has_more: boolean | null;
  error: DiscoveryFailure | null;
}
export interface DiscoveryCandidate extends Omit<SearchHit, "rank"> {
  id: string;
  platform: "bilibili";
  content_type: "video";
  content_status: "not_read";
  media_access: "not_checked";
  duration_basis: "search_metadata";
  occurrences: Array<{ query_id: string; rank: number }>;
  ranking: { method: "reciprocal_rank_fusion"; k: 60; score: number; basis: "search_metadata"; reason: string };
}
export interface DiscoveryResult {
  schema_version: "1.0";
  status: "complete" | "partial" | "unavailable";
  platform: "bilibili";
  question: string;
  queries: DiscoveryQuery[];
  candidates: DiscoveryCandidate[];
  search_exhaustive: false;
  stop_reason: "completed" | "deadline" | "cancelled" | "blocked" | "auth_required" | "rate_limited" | "error";
  limits: { max_queries: 3; pages_per_query: 1; results_per_query: 20; max_candidates: number; timeout_seconds: number; max_response_bytes: number };
  processing: { duration_ms: number; queries_attempted: number; candidates_received: number; duplicates_merged: number; candidates_omitted: number };
  warnings: string[];
  errors: Array<DiscoveryFailure & { query_id?: string }>;
}
