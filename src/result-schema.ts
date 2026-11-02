import { z } from "zod";

const availability = z.enum(["available", "absent", "unsupported", "disabled", "not_requested", "error", "auth_required", "blocked", "unknown"]);
const capability = z.object({ status: availability, reason: z.string().optional() });
const platform = z.enum(["bilibili", "youtube"]);
const properties = z.record(z.string(), z.unknown());

/** The discoverable MCP result contract; semantic verification is separate. */
export const researchResultShape = {
  schema_version: z.literal("1.0"),
  status: z.enum(["complete", "partial", "unavailable"]),
  video: z.object({
    platform, id: z.string(), partId: z.string().optional(), sourceUrl: z.string(),
    canonicalUrl: z.string(), title: z.string(), description: z.string().optional(),
    uploader: z.string().optional(), durationSeconds: z.number(), metadata: properties.optional(),
  }).nullable(),
  request: properties,
  capabilities: z.object({ metadata: capability, captions: capability, media: capability, comments: capability }),
  evidence: z.array(z.object({
    id: z.string(), kind: z.enum(["metadata", "caption", "asr", "visual", "multimodal", "community"]),
    source: z.object({ platform, video_id: z.string(), part_id: z.string().optional(), url: z.string(), origin: z.string() }),
    time_range: z.object({ start_seconds: z.number(), end_seconds: z.number() }).nullable(),
    time_basis: z.enum(["source", "none"]), precision: z.enum(["caption_cue", "requested_window", "unknown"]),
    content: z.string().optional(), data: properties.optional(), language: z.string().optional(), limitations: z.array(z.string()),
  })),
  findings: z.array(z.object({
    id: z.string(), statement: z.string(), evidence_ids: z.array(z.string()),
    verification: z.literal("unverified"), limitations: z.array(z.string()),
  })),
  analysis: z.string().nullable(),
  warnings: z.array(z.string()),
  errors: z.array(z.object({ code: z.string(), stage: z.string(), message: z.string(), retryable: z.boolean() })),
  processing: z.object({
    duration_ms: z.number(), stage_durations_ms: z.record(z.string(), z.number()),
    provider: z.string().nullable(), model: z.string().optional(), usage: z.null(),
    download_bytes: z.number().optional(), source_quality: properties.optional(),
  }),
};

export const researchResultSchema = z.object(researchResultShape);
