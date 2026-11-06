import { createHash } from "node:crypto";
import { z } from "zod";
import { getAdapter, parseSourceUrl } from "./adapters/index.js";
import { comparisonInputSchema, comparisonResultSchema } from "./comparison-schema.js";
import { longVideoResultSchema } from "./long-video-schema.js";
import { noteResearchResultSchema, xiaohongshuResearchResultSchema } from "./note-result-schema.js";
import { researchResultSchema } from "./result-schema.js";
import type { LinkResearchAction, LinkResearchTaskRecord } from "./link-research-contracts.js";

const inputUrl = z.string().trim().min(1).max(8192).refine(value => {
  try { getAdapter(value); return true; } catch { return false; }
}, "Supply a supported Bilibili, YouTube or Xiaohongshu URL or share text.");
const question = z.string().trim().min(3).max(2000);
const mode = z.enum(["language", "vision", "multimodal"]);
const language = z.string().min(2).max(20).optional();
const totalTimeoutSeconds = z.number().int().min(15).max(3600);
const actionTimeoutSeconds = z.number().int().min(15).max(600);
const maxActions = z.number().int().min(1).max(16);
const segmentSeconds = z.number().int().min(120).max(900);
const maxSegments = z.number().int().min(1).max(24);
const maxDetailWindows = z.number().int().min(0).max(4);

export const linkResearchRequestSchema = z.strictObject({
  urls: z.array(inputUrl).min(1).max(3), question, mode: mode.default("language"), language,
  totalTimeoutSeconds: totalTimeoutSeconds.default(1800), actionTimeoutSeconds: actionTimeoutSeconds.default(240),
  maxActions: maxActions.default(12), segmentSeconds: segmentSeconds.default(600),
  maxSegments: maxSegments.default(12), maxDetailWindows: maxDetailWindows.optional(),
}).transform(input => ({ ...input, maxDetailWindows: input.maxDetailWindows ?? (input.mode === "language" ? 0 : 2) }))
  .refine(input => input.mode !== "language" || input.maxDetailWindows === 0, "Language research requires zero visual detail windows.");

export const continueLinkResearchRequestSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(4).default(3),
  sourceUrls: z.array(z.strictObject({ sourceId: z.string().regex(/^source:[1-3]$/), url: inputUrl })).max(3).optional(),
}).refine(input => !input.sourceUrls || new Set(input.sourceUrls.map(source => source.sourceId)).size === input.sourceUrls.length,
  "Supply at most one fresh URL per source.");

/** Omitted research settings inherit the parent; the new task has its own budget. */
export const followUpLinkResearchRequestSchema = z.strictObject({
  question, mode: mode.default("language"), language,
  totalTimeoutSeconds: totalTimeoutSeconds.optional(), actionTimeoutSeconds: actionTimeoutSeconds.optional(),
  maxActions: maxActions.optional(), segmentSeconds: segmentSeconds.optional(), maxSegments: maxSegments.optional(),
  maxDetailWindows: maxDetailWindows.optional(),
  sourceUrls: z.array(z.strictObject({ sourceId: z.string().regex(/^source:[1-3]$/), url: inputUrl })).max(3).optional(),
}).refine(input => input.mode !== "language" || (input.maxDetailWindows ?? 0) === 0, "Language research requires zero visual detail windows.")
  .refine(input => !input.sourceUrls || new Set(input.sourceUrls.map(source => source.sourceId)).size === input.sourceUrls.length,
    "Supply at most one fresh URL per source.");

const normalizedRequestSchema = z.strictObject({
  urls: z.array(inputUrl).min(1).max(3), question, mode, language,
  totalTimeoutSeconds, actionTimeoutSeconds, maxActions, segmentSeconds, maxSegments, maxDetailWindows,
});
const sourceId = z.string().regex(/^source:[1-3]$/);
const tool = z.enum(["analyze_long_video_url", "analyze_xiaohongshu_note", "resume_long_video_research", "compare_research_materials", "answer_research_materials"]);
const key = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotMaterial = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("video"), result: z.record(z.string(), z.unknown()), label: z.string().trim().min(1).max(100).optional() }),
  z.strictObject({ kind: z.literal("note"), result: z.record(z.string(), z.unknown()), label: z.string().trim().min(1).max(100).optional() }),
]);
export const linkResearchTaskRecordSchema = z.strictObject({
  schema_version: z.literal("2"), kind: z.literal("link_research"), id: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(), request: normalizedRequestSchema,
  sources: z.array(z.strictObject({ id: sourceId, url: inputUrl, kind: z.enum(["video", "xiaohongshu"]) })).min(1).max(3),
  actions: z.array(z.strictObject({
    index: z.number().int().nonnegative().max(15), key, source_id: sourceId.nullable(), tool,
    arguments: z.record(z.string(), z.unknown()), basis: z.array(z.number().int().nonnegative().max(15)).max(16),
    timeout_seconds: actionTimeoutSeconds, state: z.enum(["running", "recorded", "unknown"]),
    started_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable(), result: z.record(z.string(), z.unknown()).nullable(),
    error: z.strictObject({ code: z.string().min(1).max(100), message: z.string().max(2000) }).nullable(),
  })).max(16),
  status: z.enum(["ready", "running", "completed", "partial", "needs_attention", "budget_exhausted", "cancelled"]),
  budget: z.strictObject({ max_actions: maxActions, attempted_actions: z.number().int().min(0).max(16), total_timeout_seconds: totalTimeoutSeconds, reserved_timeout_seconds: z.number().int().min(0).max(3600) }),
  stop_reason: z.string().max(100),
  follow_up: z.strictObject({
    parent_task_id: z.string().uuid(), parent_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    snapshots: z.array(z.strictObject({ source_id: sourceId, material: snapshotMaterial.nullable() })).min(1).max(3),
  }).optional(),
});

const timeout = { timeout_seconds: actionTimeoutSeconds };
const longArguments = z.strictObject({
  url: inputUrl, question, mode, language, ...timeout,
  segment_seconds: segmentSeconds.optional(), max_segments: maxSegments.optional(), max_detail_windows: maxDetailWindows.optional(),
  detail_window_seconds: z.number().int().min(30).max(300).optional(), max_download_mb: z.number().int().min(32).max(2048).optional(),
  window_timeout_seconds: actionTimeoutSeconds.optional(), save_session: z.literal(true).optional(),
});
const noteArguments = z.strictObject({
  url: inputUrl, question, mode: z.enum(["text", "vision", "combined"]), language, ...timeout,
  start_page: z.number().int().positive().optional(), end_page: z.number().int().positive().optional(),
});
const resumeArguments = z.strictObject({
  session_id: z.string().uuid(), url: inputUrl.optional(), ...timeout,
  window_timeout_seconds: actionTimeoutSeconds.optional(), max_download_mb: z.number().int().min(32).max(2048).optional(),
});
const comparisonArguments = z.strictObject({
  question, language, ...timeout, max_comparisons: z.number().int().min(1).max(8).optional(),
  materials: z.array(comparisonInputSchema).min(2).max(3).optional(),
});
const answerArguments = z.strictObject({ question, language, ...timeout, materials_hash: key });

/** Execution budgets are not part of the identity of an attempted operation. */
export function linkActionKey(action: Pick<LinkResearchAction, "tool" | "source_id" | "arguments" | "basis">): string {
  const { timeout_seconds: _timeout, window_timeout_seconds: _window, max_download_mb: _download, ...semantic } = action.arguments;
  return createHash("sha256").update(JSON.stringify({ tool: action.tool, source_id: action.source_id, arguments: semantic, basis: action.basis })).digest("hex");
}

/** The ordinary Xiaohongshu wrapper schema otherwise strips nested long-video state. */
export function parseLinkActionResult(action: Pick<LinkResearchAction, "tool">, input: unknown): Record<string, unknown> {
  if (["compare_research_materials", "answer_research_materials"].includes(action.tool)) return comparisonResultSchema.parse(input);
  if (action.tool !== "analyze_xiaohongshu_note") return longVideoResultSchema.parse(input);
  const wrapper = xiaohongshuResearchResultSchema.parse(input);
  const raw = input as { result?: unknown };
  if (wrapper.content_type === "image_note") {
    if (!wrapper.result) throw new Error("An image note result must contain its note report.");
    wrapper.result = noteResearchResultSchema.parse(raw.result);
  } else if (wrapper.content_type === "video_note") {
    if (!raw.result || typeof raw.result !== "object") throw new Error("A video note result must contain its video report.");
    wrapper.result = "plan" in raw.result || "segments" in raw.result || "session" in raw.result
      ? longVideoResultSchema.parse(raw.result) : researchResultSchema.parse(raw.result);
  } else if (wrapper.result !== null || wrapper.status === "complete") throw new Error("An unresolved note cannot report complete research.");
  return wrapper;
}

function publicUrl(value: string): boolean {
  try {
    const url = parseSourceUrl(value);
    return url.toString() === value && !url.hash && [...url.searchParams.keys()].every(k => ["p", "v"].includes(k));
  } catch { return false; }
}

export function parseLinkResearchTaskRecord(input: unknown, id?: string): LinkResearchTaskRecord {
  const record = linkResearchTaskRecordSchema.parse(input) as LinkResearchTaskRecord;
  const bad = (): never => { throw Object.assign(new Error("The link research task has inconsistent source, action or budget records."), { code: "TASK_CORRUPT" }); };
  const request = record.request;
  if (id !== undefined && record.id !== id || record.sources.length !== request.urls.length || request.mode === "language" && request.maxDetailWindows !== 0 ||
      record.budget.max_actions !== request.maxActions || record.budget.total_timeout_seconds !== request.totalTimeoutSeconds ||
      record.budget.attempted_actions !== record.actions.length || record.actions.length > request.maxActions) bad();
  for (const [index, source] of record.sources.entries()) {
    if (source.id !== `source:${index + 1}` || source.url !== request.urls[index] || !publicUrl(source.url)) bad();
    if ((getAdapter(source.url).platform === "xiaohongshu" ? "xiaohongshu" : "video") !== source.kind) bad();
  }
  if (record.follow_up && (record.follow_up.parent_task_id === record.id || record.follow_up.snapshots.length !== record.sources.length ||
      record.follow_up.snapshots.some((snapshot, index) => snapshot.source_id !== record.sources[index].id))) bad();
  const keys = new Set<string>();
  let reserved = 0;
  for (const [index, action] of record.actions.entries()) {
    if (action.index !== index || action.key !== linkActionKey(action) || keys.has(action.key) || new Set(action.basis).size !== action.basis.length ||
        action.basis.some(prior => prior >= index || record.actions[prior].state !== "recorded")) bad();
    keys.add(action.key); reserved += action.timeout_seconds;
    const args: Record<string, unknown> = (action.tool === "analyze_long_video_url" ? longArguments : action.tool === "analyze_xiaohongshu_note" ? noteArguments : action.tool === "resume_long_video_research" ? resumeArguments : action.tool === "answer_research_materials" ? answerArguments : comparisonArguments).parse(action.arguments);
    if (args.timeout_seconds !== action.timeout_seconds || (typeof args.url === "string" && !publicUrl(args.url))) bad();
    if (action.tool === "answer_research_materials") {
      const latest = record.sources.flatMap(source => {
        const prior = record.actions.slice(0, index).filter(a => a.source_id === source.id && a.state === "recorded").at(-1);
        return prior ? [prior.index] : [];
      });
      if (!record.follow_up || action.source_id !== null || args.question !== request.question || args.language !== request.language ||
          action.timeout_seconds !== Math.min(120, request.actionTimeoutSeconds) || JSON.stringify(action.basis) !== JSON.stringify(latest)) bad();
    } else if (action.tool === "compare_research_materials") {
      if (record.follow_up) bad();
      if (action.source_id !== null || action.basis.length < 2 || action.basis.some(prior => record.actions[prior].source_id === null) || args.question !== request.question) bad();
      const sourceIds = action.basis.map(prior => record.actions[prior].source_id);
      if (new Set(sourceIds).size !== sourceIds.length || action.timeout_seconds > Math.min(120, request.actionTimeoutSeconds)) bad();
    } else {
      const source = record.sources.find(source => source.id === action.source_id) ?? bad();
      if (record.follow_up && request.mode === "language") bad();
      if (action.timeout_seconds !== request.actionTimeoutSeconds || action.basis.some(prior => record.actions[prior].source_id !== source.id)) bad();
      if ("question" in args && args.question !== request.question || "language" in args && args.language !== request.language) bad();
      if (action.tool === "analyze_long_video_url") {
        if (source.kind !== "video" || args.mode !== (record.follow_up ? "vision" : request.mode)) bad();
        const prior = record.actions.slice(0, index).filter(a => a.source_id === source.id);
        if (prior.length) {
          // A supplied fresh URL may retry resolution that never produced a usable
          // source/session. Existing read work must go through its saved session.
          if (action.basis.length !== 1 || action.basis[0] !== prior.at(-1)!.index ||
              prior.some(a => a.result?.video !== null || a.result?.session)) bad();
        } else if (action.basis.length) bad();
      }
      if (action.tool === "analyze_xiaohongshu_note") {
        const expectedMode = record.follow_up ? "vision" : request.mode === "language" ? "text" : request.mode === "multimodal" ? "combined" : "vision";
        if (source.kind !== "xiaohongshu" || (action.basis.length && !record.follow_up ? request.mode !== "multimodal" && args.mode !== expectedMode : args.mode !== expectedMode) || (args.start_page === undefined) !== (args.end_page === undefined) ||
            args.start_page !== undefined && Number(args.start_page) > Number(args.end_page)) bad();
      }
      if (action.tool === "resume_long_video_research" && !action.basis.length) bad();
    }
    if (action.state === "recorded") {
      if (!action.result || !action.finished_at || action.error) bad();
      action.result = parseLinkActionResult(action, action.result);
      const leaf = action.tool === "analyze_xiaohongshu_note" ? action.result.result : action.result;
      if (leaf && typeof leaf === "object" && "request" in leaf && (leaf.request as { question: string }).question.trim() !== request.question) bad();
      if (["compare_research_materials", "answer_research_materials"].includes(action.tool) && action.result.question !== request.question) bad();
    } else {
      if (index !== record.actions.length - 1 || action.result || action.state === "running" && (action.finished_at || action.error) ||
          action.state === "unknown" && (!action.finished_at || !action.error)) bad();
    }
  }
  if (reserved !== record.budget.reserved_timeout_seconds || reserved > record.budget.total_timeout_seconds) bad();
  return record;
}

export const linkResearchTaskViewShape = {
  task: linkResearchTaskRecordSchema,
  progress: z.array(z.strictObject({ source_id: sourceId, status: z.enum(["pending", "complete", "partial", "unavailable"]), can_continue: z.boolean(), reason: z.string() })).min(1).max(3),
  materials: z.array(comparisonInputSchema).max(3), comparison: comparisonResultSchema.nullable(), comparison_current: z.boolean(), limitations: z.array(z.string()),
  answer: comparisonResultSchema.nullable().optional(), answer_current: z.boolean().optional(),
};
export const linkResearchTaskViewSchema = z.strictObject(linkResearchTaskViewShape);
