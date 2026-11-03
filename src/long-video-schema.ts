import { z } from "zod";
import { researchResultShape } from "./result-schema.js";

const window = z.object({ start_seconds: z.number().nonnegative(), end_seconds: z.number().positive() });
export const longVideoResultShape = {
  ...researchResultShape,
  follow_up: z.object({ parent_session_id: z.string().uuid(), parent_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reused_evidence_ids: z.array(z.string()) }).optional(),
  session: z.object({ id: z.string().uuid(), revision: z.number().int().positive(), created_at: z.string(), updated_at: z.string(), reused_segments: z.number().int().nonnegative(), processed_segments: z.number().int().nonnegative() }).nullable().optional(),
  plan: z.object({
    strategy: z.literal("segmented_overview_then_detail"), requested_window: window,
    segment_seconds: z.number(), overview_windows: z.array(window), max_detail_windows: z.number(),
    detail_window_seconds: z.number(), max_download_bytes: z.number(), window_timeout_seconds: z.number(),
  }).nullable(),
  segments: z.array(z.object({
    id: z.string(), phase: z.enum(["overview", "detail"]), window,
    status: z.enum(["pending", "complete", "partial", "failed"]),
    basis: z.enum(["captions", "audio", "video", "audio_video"]),
    evidence_ids: z.array(z.string()), analysis: z.string().nullable(),
    relevance_score: z.number().optional(), proposed_focus_offset_seconds: z.number().optional(), error: z.string().optional(),
  })),
  coverage: z.object({
    overview: z.array(window), detail: z.array(window), unreviewed: z.array(window),
    overview_complete: z.boolean(), limitations: z.array(z.string()),
  }),
};
export const longVideoResultSchema = z.object(longVideoResultShape);
