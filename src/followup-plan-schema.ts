import { z } from "zod";
import { comparisonInputSchema } from "./comparison-schema.js";
import { discoveryRequestSchema, discoveryResultSchema } from "./discovery-schema.js";

const searchQueries = discoveryRequestSchema.shape.queries.unwrap();

export const followupPlanRequestSchema = z.strictObject({
  question: z.string().trim().min(3).max(2000), materials: z.array(comparisonInputSchema).min(1).max(3),
  evidenceRequirement: z.enum(["original", "language", "vision", "multimodal"]).default("original"), coverageTarget: z.enum(["requested", "source"]).default("requested"),
  searchQueries: searchQueries.optional(), discovery: discoveryResultSchema.optional(),
  maxActions: z.number().int().min(1).max(5).default(3), maxSources: z.number().int().min(1).max(3).default(2), maxRounds: z.number().int().min(1).max(5).default(2), round: z.number().int().min(1).max(10).default(1),
  attemptedActionKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(50).default([]),
  videoWindowSeconds: z.number().int().min(30).max(900).default(180), notePagesPerAction: z.number().int().min(1).max(10).default(4), actionTimeoutSeconds: z.number().int().min(15).max(600).default(240), planningTimeoutSeconds: z.number().min(1).max(30).default(10),
});
const window = z.object({ start_seconds: z.number().nonnegative(), end_seconds: z.number().positive() });
const pages = z.object({ start_page: z.number().int().positive(), end_page: z.number().int().positive() });
const quality = z.object({ profile: z.enum(["standard", "high", "custom"]).optional(), resolution: z.enum(["720p", "1080p", "1440p", "2160p"]).optional(), fps: z.union([z.literal(30),z.literal(60)]).optional(), on_unavailable: z.enum(["error", "warn"]).optional() });
const failure = z.object({ code: z.string(), message: z.string() });
export const planningMaterialSchema = z.object({
  id: z.string(), source_key: z.string().nullable(), url: z.string().nullable(), family: z.enum(["video", "note"]).nullable(), original_mode: z.enum(["language", "vision", "multimodal"]).nullable(), source_status: z.enum(["complete", "partial", "unavailable"]), eligible: z.boolean(),
  requested_window: window.nullable(), duration_seconds: z.number().positive().nullable(), requested_pages: pages.nullable(), image_count: z.number().int().nonnegative().nullable(),
  language_windows: z.array(window), visual_windows: z.array(window), language_pages: z.array(z.number().int().positive()), visual_pages: z.array(z.number().int().positive()), evidence_ids: z.array(z.string()),
  visual_question_changed: z.boolean(), session_id: z.string().uuid().nullable(), can_resume: z.boolean(), resume_window_seconds: z.number().positive().optional(), language: z.string().optional(), source_quality: quality.optional(),
  access: z.enum(["not_checked", "blocked", "auth_required", "rate_limited"]), errors: z.array(failure), limitations: z.array(z.string()),
});
const common = { key: z.string().regex(/^[a-f0-9]{64}$/), gap_ids: z.array(z.string()), material_ids: z.array(z.string()), source_key: z.string().nullable(), reason: z.string(), preconditions: z.array(z.string()) };
export const followupActionSchema = z.discriminatedUnion("tool", [
  z.object({ ...common, tool: z.literal("analyze_video_url"), arguments: z.strictObject({ url: z.string().url(), question: z.string().min(3), mode: z.enum(["language", "vision", "multimodal"]), include_comments: z.literal(false), start_seconds: z.number().nonnegative(), end_seconds: z.number().positive(), timeout_seconds: z.number().min(15).max(600), language: z.string().optional(), source_quality: quality.optional() }) }),
  z.object({ ...common, tool: z.literal("analyze_xiaohongshu_note"), arguments: z.strictObject({ url: z.string().url(), question: z.string().min(3), mode: z.enum(["text", "vision", "combined"]), start_page: z.number().int().positive(), end_page: z.number().int().positive(), timeout_seconds: z.number().min(15).max(600), language: z.string().optional() }) }),
  z.object({ ...common, tool: z.literal("resume_long_video_research"), arguments: z.strictObject({ session_id: z.string().uuid(), timeout_seconds: z.number().min(15).max(600), window_timeout_seconds: z.number().int().min(15).max(600), max_download_mb: z.literal(64) }) }),
  z.object({ ...common, tool: z.literal("discover_bilibili_videos"), arguments: z.strictObject({ question: z.string().min(3).max(2000), queries: searchQueries, max_candidates: z.literal(10), timeout_seconds: z.number().min(1).max(120) }) }),
]);
export const followupPlanResultShape = {
  schema_version: z.literal("1.0"), status: z.enum(["planned", "stopped", "unavailable"]), question: z.string(), materials: z.array(planningMaterialSchema),
  gaps: z.array(z.object({ id: z.string(), material_ids: z.array(z.string()), source_key: z.string().nullable(), kind: z.enum(["coverage_gap", "scope_extension", "visual_question_changed", "access_blocked", "invalid_material", "requested_search"]), channel: z.enum(["language", "vision", "multimodal"]).nullable(), window: window.nullable(), pages: pages.nullable(), evidence_ids: z.array(z.string()), reason: z.string(), state: z.enum(["actionable", "blocked", "deferred", "previously_attempted", "needs_selection"]) })),
  next_actions: z.array(followupActionSchema).max(5), stop_reason: z.enum(["actions_available", "no_actionable_gaps", "budget_exhausted", "history_exhausted", "blocked", "cancelled", "timeout", "invalid_request"]),
  budget: z.object({ max_actions: z.number(), max_sources: z.number(), max_rounds: z.number(), round: z.number(), deferred_gaps: z.number().int().nonnegative() }), warnings: z.array(z.string()), errors: z.array(failure),
  processing: z.object({ duration_ms: z.number().nonnegative(), model_calls: z.literal(0), executed_actions: z.literal(0) }),
};
export const followupPlanResultSchema = z.object(followupPlanResultShape);
