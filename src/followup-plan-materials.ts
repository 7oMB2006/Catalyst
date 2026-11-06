import { z } from "zod";
import type { ExecutionContext, ResearchResult, SourceContext } from "./contracts.js";
import type { ComparisonInput } from "./comparison-contracts.js";
import type { NoteResearchResult, XiaohongshuResearchResult } from "./note-contracts.js";
import type { LongVideoRequest, LongVideoResult } from "./long-video-contracts.js";
import type { PlanningMaterial, PlanWindow } from "./followup-plan-contracts.js";
import { prepareComparisonMaterials } from "./comparison-materials.js";
import { ResearchSessionStore, type ResearchSessionRecord } from "./research-session-store.js";
import { sessionCompatibility } from "./research-sessions.js";
import { longVideoResultSchema } from "./long-video-schema.js";
import { validateContinuation } from "./long-video-continuation.js";
import { redactSensitiveText } from "./video-analysis.js";

const MAX_DURATION = 31 * 24 * 60 * 60;
const quality = z.object({ profile: z.enum(["standard", "high", "custom"]).optional(), resolution: z.enum(["720p", "1080p", "1440p", "2160p"]).optional(), fps: z.union([z.literal(30), z.literal(60)]).optional(), onUnavailable: z.enum(["error", "warn"]).optional() });
const language = z.string().min(2).max(20);
const validationCodes = new Set(["MATERIAL_INVALID", "MATERIAL_BUDGET_EXCEEDED", "SESSION_CORRUPT", "SESSION_TOO_LARGE", "SESSION_IO_ERROR", "SESSION_NOT_FOUND", "INVALID_SESSION_ID"]);
const sourceStages = new Set(["source", "resolve", "acquire", "overview_acquire", "detail_acquire"]);
const isSourceFailure = (issue: { stage: string }) => sourceStages.has(issue.stage.split("/").at(-1)!);
const safe = (value: string) => redactSensitiveText(value);
function invalid(message: string): never { throw Object.assign(new Error(message), { code: "MATERIAL_INVALID" }); }
function check(context: ExecutionContext): void {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadlineMs) throw new DOMException("Planning material deadline expired.", "TimeoutError");
}
function uniqueWindows(items: PlanWindow[], requested: PlanWindow): PlanWindow[] {
  const bounded = items.map((w) => ({ start_seconds: Math.max(w.start_seconds, requested.start_seconds), end_seconds: Math.min(w.end_seconds, requested.end_seconds) })).filter((w) => w.end_seconds > w.start_seconds);
  return [...new Map(bounded.map((w) => [`${w.start_seconds}:${w.end_seconds}`, w])).values()].sort((a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds);
}
function accessOf(result: ResearchResult | NoteResearchResult, outer?: XiaohongshuResearchResult): PlanningMaterial["access"] {
  const codes = [...result.errors, ...(outer?.errors ?? [])].filter(isSourceFailure).map((e) => e.code);
  const caps = "video" in result ? [result.capabilities.metadata, result.capabilities.media] : [result.capabilities.body, result.capabilities.images];
  if (codes.some((c) => ["ACCESS_BLOCKED", "SEARCH_BLOCKED", "HTTP_412"].includes(c)) || caps.some((c) => c.status === "blocked")) return "blocked";
  if (codes.some((c) => ["AUTH_REQUIRED", "SEARCH_AUTH_REQUIRED"].includes(c)) || caps.some((c) => c.status === "auth_required")) return "auth_required";
  if (codes.some((c) => ["RATE_LIMITED", "SEARCH_RATE_LIMITED"].includes(c))) return "rate_limited";
  return "not_checked";
}
function settings(material: PlanningMaterial, request: ResearchResult["request"] | NoteResearchResult["request"]): void {
  if (request.language !== undefined) {
    const parsed = language.safeParse(request.language);
    if (!parsed.success || safe(parsed.data) !== parsed.data) invalid("The material has an invalid original language setting.");
    material.language = parsed.data;
  }
  if ("sourceQuality" in request && request.sourceQuality !== undefined) {
    const parsed = quality.safeParse(request.sourceQuality);
    if (!parsed.success || (parsed.data.profile === "custom" && (!parsed.data.resolution || !parsed.data.fps))) invalid("The material has invalid original source-quality settings.");
    const q = parsed.data;
    material.source_quality = { ...(q.profile !== undefined ? { profile: q.profile } : {}), ...(q.resolution !== undefined ? { resolution: q.resolution } : {}), ...(q.fps !== undefined ? { fps: q.fps } : {}), ...(q.onUnavailable !== undefined ? { on_unavailable: q.onUnavailable } : {}) };
  }
}

/** Validate the saved plan independently of the supplied overview-window list. */
export function validateLongPlan(input: unknown, requested: PlanWindow): LongVideoResult {
  const candidate = input as Partial<LongVideoResult>;
  if (!candidate.plan || !Array.isArray(candidate.segments) || candidate.segments.length > 28 || candidate.segments.some((segment) => !segment || !Array.isArray(segment.evidence_ids) || segment.evidence_ids.length > 80) || !Array.isArray(candidate.plan.overview_windows) || candidate.plan.overview_windows.length > 24 || !candidate.coverage || [candidate.coverage.overview, candidate.coverage.detail, candidate.coverage.unreviewed].some((items) => !Array.isArray(items) || items.length > 28)) invalid("The material long-video arrays exceed their planning bounds.");
  const parsed = longVideoResultSchema.safeParse(input);
  if (!parsed.success || !parsed.data.video || !parsed.data.plan) invalid("The material has an invalid long-video plan.");
  const result = parsed.data as unknown as LongVideoResult, request = result.request as LongVideoRequest, plan = result.plan!;
  const segment = request.segmentSeconds ?? 600, maxSegments = request.maxSegments ?? 12, details = request.maxDetailWindows ?? 2, detailSeconds = request.detailWindowSeconds ?? 120;
  const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (!integer(segment, 120, 900) || !integer(maxSegments, 1, 24) || !integer(details, 0, 4) || !integer(detailSeconds, 30, 300) || !integer(request.windowTimeoutSeconds ?? 180, 15, 600) || !integer(request.maxDownloadMB ?? 512, 32, 2048)) invalid("The material has invalid long-video planning settings.");
  const count = Math.ceil((requested.end_seconds - requested.start_seconds) / segment);
  if (!integer(count, 1, maxSegments)) invalid("The material long-video overview exceeds its segment budget.");
  const windows = Array.from({ length: count }, (_, index) => ({ start_seconds: requested.start_seconds + index * segment, end_seconds: Math.min(requested.end_seconds, requested.start_seconds + (index + 1) * segment) }));
  const expected = { ...plan, requested_window: requested, segment_seconds: segment, overview_windows: windows, max_detail_windows: details, detail_window_seconds: detailSeconds };
  if (plan.window_timeout_seconds !== (request.windowTimeoutSeconds ?? 180) || plan.max_download_bytes !== (request.maxDownloadMB ?? 512) * 1024 * 1024) invalid("The material long-video runtime plan does not match its request.");
  const source: SourceContext = { video: result.video!, captions: { status: "not_requested", kind: "unknown", cues: [] }, comments: { status: "disabled", items: [] }, capabilities: result.capabilities, warnings: [] };
  try { validateContinuation(result, request, source, expected); }
  catch { invalid("The material long-video plan, segment identities or completed references are invalid."); }
  return result;
}

/** Read each session once, then derive only validated, bounded coverage; no external work. */
export async function preparePlanningMaterials(inputs: ComparisonInput[], question: string, context: ExecutionContext): Promise<PlanningMaterial[]> {
  const loaded = new Map<string, Promise<ResearchSessionRecord>>(), snapshots = new Map<number, ResearchSessionRecord>(), loadErrors = new Map<number, { code: string; message: string }>();
  const resolved: ComparisonInput[] = [];
  for (const [index, input] of inputs.entries()) {
    check(context);
    if (!input || typeof input !== "object" || input.kind !== "session") { resolved.push(input); continue; }
    try {
      let promise = loaded.get(input.session_id);
      if (!promise) { promise = new ResearchSessionStore().load(input.session_id); loaded.set(input.session_id, promise); }
      const record = await promise; check(context);
      if (JSON.stringify(record.request) !== JSON.stringify(record.result.request)) invalid("The saved request does not match its result.");
      snapshots.set(index, record); resolved.push({ kind: "video", result: record.result, ...(input.label !== undefined ? { label: input.label } : {}) });
    } catch (error) {
      check(context);
      const e = error as { code?: string; message?: string };
      loadErrors.set(index, { code: typeof e.code === "string" ? e.code : "MATERIAL_INVALID", message: safe(e.message ?? "The saved material could not be read.") });
      resolved.push({ kind: "video", result: {} as ResearchResult, ...(input.label !== undefined ? { label: input.label } : {}) });
    }
  }
  const prepared = await prepareComparisonMaterials(resolved, question, context), output: PlanningMaterial[] = [];
  for (const [index, normalized] of prepared.materials.entries()) {
    check(context);
    const material: PlanningMaterial = { id: normalized.id, source_key: normalized.source_key, url: normalized.url, family: null, original_mode: null, source_status: "unavailable", eligible: false, requested_window: null, duration_seconds: null, requested_pages: null, image_count: null, language_windows: [], visual_windows: [], language_pages: [], visual_pages: [], evidence_ids: [], visual_question_changed: false, session_id: null, can_resume: false, access: "not_checked", errors: [...normalized.errors, ...(loadErrors.has(index) ? [loadErrors.get(index)!] : [])].map((e) => ({ code: safe(e.code), message: safe(e.message) })), limitations: [...normalized.limitations] };
    try {
      if (!material.source_key || !material.url || loadErrors.has(index) || material.errors.some((e) => validationCodes.has(e.code))) invalid("The material has no valid source metadata for a follow-up action.");
      const input = resolved[index];
      let raw: ResearchResult | NoteResearchResult, outer: XiaohongshuResearchResult | undefined;
      if (input.kind === "video" || input.kind === "note") raw = input.result;
      else if (input.kind === "xiaohongshu") { outer = input.result; if (!outer.result) invalid("The material has no resolved research result."); raw = outer.result; }
      else invalid("The material snapshot is unavailable.");
      material.source_status = outer?.status ?? raw.status;
      material.access = accessOf(raw, outer); settings(material, raw.request);
      if (material.access === "not_checked" && [...raw.errors, ...(outer?.errors ?? [])].some(isSourceFailure)) material.limitations.push("A source-stage failure was retained without a typed access restriction. Access remains not_checked; freeform diagnostics do not establish blocking, authentication requirements or rate limiting.");
      const evidence = prepared.evidence.filter((e) => e.material_id === normalized.id);
      material.evidence_ids = evidence.map((e) => e.id);
      if ("video" in raw) {
        if (!raw.video || !Number.isFinite(raw.video.durationSeconds) || raw.video.durationSeconds <= 0 || raw.video.durationSeconds > MAX_DURATION) invalid("The video duration exceeds the finite 31-day planning bound.");
        material.family = "video"; material.duration_seconds = raw.video.durationSeconds; material.original_mode = raw.request.mode;
        const requested = { start_seconds: raw.request.startSeconds ?? 0, end_seconds: raw.request.endSeconds ?? raw.video.durationSeconds };
        if (!Number.isFinite(requested.start_seconds) || !Number.isFinite(requested.end_seconds) || requested.start_seconds < 0 || requested.end_seconds <= requested.start_seconds || requested.end_seconds > raw.video.durationSeconds) invalid("The selected video planning window is invalid.");
        material.requested_window = requested;
        material.visual_question_changed = ["vision", "multimodal"].includes(raw.request.mode) && raw.request.question.trim() !== question.trim();
        material.language_windows = uniqueWindows(evidence.filter((e) => e.basis === "source_text" && ["caption", "asr"].includes(e.kind) && e.locator.time_range).map((e) => e.locator.time_range!), requested);
        material.visual_windows = uniqueWindows(evidence.filter((e) => e.basis === "derived_observation" && ["visual", "multimodal"].includes(e.kind) && e.locator.time_range).map((e) => e.locator.time_range!), requested);
        const possibleLong = raw as ResearchResult & { plan?: unknown };
        let validLong: LongVideoResult | null = null;
        if (possibleLong.plan !== undefined && possibleLong.plan !== null) validLong = validateLongPlan(raw, requested);
        const sameQuestion = raw.request.question.trim() === question.trim(), visualMode = ["vision", "multimodal"].includes(raw.request.mode);
        if (!validLong && raw.request.mode === "language" && raw.capabilities.captions.status === "available" && raw.evidence.some((e) => e.kind === "caption" && e.precision === "caption_cue")) {
          material.language_windows = [requested];
          material.limitations.push("The available caption track was queried for the requested scope. Cue gaps can be silence; this coverage is not proof of continuous speech or independently verified transcription.");
        }
        if (validLong) {
          material.visual_windows = sameQuestion && visualMode ? uniqueWindows(validLong.segments.filter((s) => s.status === "complete" && ["video", "audio_video"].includes(s.basis)).map((s) => s.window), requested) : [];
        } else if (sameQuestion && visualMode && raw.status === "complete" && !raw.errors.length) {
          material.visual_windows = uniqueWindows(raw.evidence.filter((e) => ["visual", "multimodal"].includes(e.kind) && e.time_range).map((e) => e.time_range!), requested);
        }
        if (snapshots.has(index)) {
          const record = snapshots.get(index)!;
          material.session_id = record.id;
          if (validLong && validLong.segments.some((s) => s.status !== "complete") && raw.request.question.trim() === question.trim()) {
            try { material.can_resume = record.compatibility === sessionCompatibility(record.request); }
            catch { material.can_resume = false; }
            if (!material.can_resume) material.limitations.push("The saved session is incompatible with the current processing settings. Retained evidence stays readable; use independent bounded reading or restore compatible settings before resuming.");
          }
          if (validLong) material.resume_window_seconds = Math.max(validLong.plan!.segment_seconds, validLong.plan!.detail_window_seconds);
        }
      } else {
        if (!raw.note || !Number.isInteger(raw.note.imageCount) || raw.note.imageCount < 0 || raw.note.imageCount > 10_000) invalid("The image count exceeds the 10,000-page planning bound.");
        material.family = "note"; material.image_count = raw.note.imageCount;
        material.original_mode = raw.request.mode === "vision" ? "vision" : raw.request.mode === "combined" ? "multimodal" : "language";
        material.requested_pages = raw.note.imageCount ? { start_page: raw.request.startPage ?? 1, end_page: raw.request.endPage ?? raw.note.imageCount } : null;
        material.visual_question_changed = material.original_mode !== "language" && raw.request.question.trim() !== question.trim();
        material.language_pages = [...new Set(evidence.filter((e) => e.basis === "source_text" && e.kind === "image_text" && e.locator.page !== null).map((e) => e.locator.page!))].sort((a, b) => a - b);
        // Each retained observation has already passed source/page validation, even if later batches or synthesis failed.
        material.visual_pages = !material.visual_question_changed && material.original_mode !== "language" ? [...new Set(raw.evidence.filter((e) => e.kind === "image_visual" && e.page !== null).map((e) => e.page!))].sort((a, b) => a - b) : [];
      }
      material.eligible = true;
      material.limitations.push("Planning coverage describes retained language evidence or validated, same-question visual processing ranges. It does not establish semantic sufficiency, exhaustive inspection, independent verification, or current media access.");
    } catch (error) {
      check(context);
      const e = error as { code?: string; message?: string };
      material.eligible = false; material.can_resume = false; material.session_id = null; material.evidence_ids = []; material.language_windows = []; material.visual_windows = []; material.language_pages = []; material.visual_pages = [];
      material.errors.push({ code: typeof e.code === "string" ? e.code : "MATERIAL_INVALID", message: safe(e.message ?? "The material metadata is not safe for planning.") });
    }
    output.push(material);
  }
  return output;
}
