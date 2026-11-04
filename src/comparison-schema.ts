import { z } from "zod";

const label = z.string().trim().min(1).max(100).optional();
export const comparisonInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("video"), result: z.record(z.string(), z.unknown()), label }),
  z.strictObject({ kind: z.literal("note"), result: z.record(z.string(), z.unknown()), label }),
  z.strictObject({ kind: z.literal("xiaohongshu"), result: z.record(z.string(), z.unknown()), label }),
  z.strictObject({ kind: z.literal("session"), session_id: z.string().uuid(), label }),
]);
export const comparisonRequestSchema = z.strictObject({
  question: z.string().trim().min(3).max(2000), materials: z.array(comparisonInputSchema).min(2).max(3),
  language: z.string().min(2).max(20).optional(), timeoutSeconds: z.number().min(1).max(300).default(120), maxComparisons: z.number().int().min(1).max(8).default(6),
});
const citation = z.strictObject({ evidence_id: z.string().min(1).max(2000), quote: z.string().trim().min(1).max(500) });
export const comparisonPositionSchema = z.strictObject({
  material_id: z.string(), stance: z.enum(["supports", "contradicts", "not_addressed", "insufficient"]), citations: z.array(citation).max(6), explanation: z.string().trim().min(1).max(1500),
});
export const generatedComparisonRowSchema = z.object({
  claim: z.string().trim().min(1).max(1000), positions: z.array(comparisonPositionSchema).max(3), limitations: z.array(z.string().max(500)).max(8),
});
const failure = z.object({ code: z.string(), message: z.string() });
const evidence = z.object({
  id: z.string(), material_id: z.string(), original_id: z.string(), kind: z.string(), basis: z.enum(["source_text", "derived_observation"]), content: z.string(),
  locator: z.object({ url: z.string(), platform: z.string(), content_id: z.string(), part_id: z.string().nullable(), time_range: z.object({ start_seconds: z.number(), end_seconds: z.number() }).nullable(), page: z.number().int().positive().nullable() }), limitations: z.array(z.string()),
});
export const comparisonResultShape = {
  schema_version: z.literal("1.0"), status: z.enum(["complete", "partial", "unavailable"]), question: z.string(),
  materials: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["ready", "partial", "unavailable"]), source_key: z.string().nullable(), source_group: z.string().nullable(), duplicate_of: z.string().nullable(), title: z.string().nullable(), url: z.string().nullable(), original_question: z.string().nullable(), evidence_ids: z.array(z.string()), limitations: z.array(z.string()), errors: z.array(failure) })),
  evidence: z.array(evidence),
  comparisons: z.array(generatedComparisonRowSchema.extend({ id: z.string(), relation: z.enum(["shared", "disputed", "single_source", "insufficient"]), verification: z.literal("unverified") })),
  analysis: z.string().nullable(), source_independence: z.literal("not_established"), warnings: z.array(z.string()), errors: z.array(failure),
  processing: z.object({ duration_ms: z.number().nonnegative(), provider: z.string().nullable(), model_calls: z.number().int().nonnegative() }),
};
export const comparisonResultSchema = z.object(comparisonResultShape);
