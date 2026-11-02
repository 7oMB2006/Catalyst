import { z } from "zod";
import { researchResultSchema } from "./result-schema.js";

const status = z.enum(["complete", "partial", "unavailable"]);
const capability = z.object({ status: z.enum(["available", "absent", "unsupported", "disabled", "not_requested", "error", "auth_required", "blocked", "unknown"]), reason: z.string().optional() });
const failure = z.object({ code: z.string(), stage: z.string(), message: z.string(), retryable: z.boolean() });

export const noteResearchResultSchema = z.object({
  schema_version: z.literal("1.0"), status,
  note: z.object({ platform: z.literal("xiaohongshu"), id: z.string(), sourceUrl: z.string(), canonicalUrl: z.string(), title: z.string(), description: z.string(), uploader: z.string().optional(), contentType: z.literal("image_note"), imageCount: z.number().int().nonnegative() }).nullable(),
  request: z.object({ url: z.string(), question: z.string(), mode: z.enum(["text", "vision", "combined"]).optional(), language: z.string().optional(), startPage: z.number().optional(), endPage: z.number().optional(), timeoutSeconds: z.number().optional() }),
  capabilities: z.object({ body: capability, images: capability, ocr: capability, comments: capability }),
  evidence: z.array(z.object({
    id: z.string(), kind: z.enum(["note_text", "image_text", "image_visual"]),
    source: z.object({ platform: z.literal("xiaohongshu"), note_id: z.string(), url: z.string(), origin: z.string() }),
    page: z.number().int().positive().nullable(), content: z.string().optional(), limitations: z.array(z.string()),
  })),
  findings: z.array(z.object({ id: z.string(), statement: z.string(), evidence_ids: z.array(z.string()), verification: z.literal("unverified"), limitations: z.array(z.string()) })),
  analysis: z.string().nullable(), warnings: z.array(z.string()), errors: z.array(failure),
  processing: z.object({ duration_ms: z.number(), stage_durations_ms: z.record(z.string(), z.number()), provider: z.string().nullable(), model: z.string().optional(), usage: z.null(), download_bytes: z.number().optional(), total_pages: z.number().optional(), selected_pages: z.array(z.number().int().positive()).optional(), processed_pages: z.array(z.number().int().positive()).optional() }),
});

export const xiaohongshuResearchResultShape = {
  schema_version: z.literal("1.0"), status,
  content_type: z.enum(["image_note", "video_note", "unknown"]),
  result: z.union([noteResearchResultSchema, researchResultSchema]).nullable(), errors: z.array(failure),
};
export const xiaohongshuResearchResultSchema = z.object(xiaohongshuResearchResultShape);
