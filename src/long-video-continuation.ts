import type { Evidence, SourceContext } from "./contracts.js";
import type { LongVideoRequest, LongVideoResult, SourceWindow } from "./long-video-contracts.js";
import { longVideoResultSchema } from "./long-video-schema.js";

function incompatible(message: string): never {
  throw Object.assign(new Error(`Saved research is incompatible: ${message}`), { code: "SESSION_INCOMPATIBLE" });
}
const sameWindow = (a: SourceWindow, b: SourceWindow) => a.start_seconds === b.start_seconds && a.end_seconds === b.end_seconds;

/** Runtime deadlines and per-invocation download budgets may change; research semantics may not. */
export function immutableResearchSettings(request: LongVideoRequest): unknown {
  return {
    question: request.question, mode: request.mode, language: request.language ?? null,
    sourceQuality: request.sourceQuality ? { profile: request.sourceQuality.profile ?? "standard", resolution: request.sourceQuality.resolution ?? null, fps: request.sourceQuality.fps ?? null, onUnavailable: request.sourceQuality.onUnavailable ?? "error" } : null,
    start: request.startSeconds ?? null, end: request.endSeconds ?? null,
    segment: request.segmentSeconds ?? 600, maxSegments: request.maxSegments ?? 12,
    details: request.maxDetailWindows ?? 2, detailSeconds: request.detailWindowSeconds ?? 120,
  };
}

export function validateContinuation(previous: LongVideoResult, request: LongVideoRequest, source: SourceContext, plan: NonNullable<LongVideoResult["plan"]>): void {
  if (!longVideoResultSchema.safeParse(previous).success || !previous.video || !previous.plan) incompatible("a valid source and plan are required.");
  const old = previous.video!, video = source.video, savedPlan = previous.plan!;
  if (old.platform !== video.platform || old.id !== video.id || old.partId !== video.partId || old.durationSeconds !== video.durationSeconds || old.canonicalUrl !== video.canonicalUrl) incompatible("the source, selected part, canonical URL or duration changed.");
  if (JSON.stringify(immutableResearchSettings(previous.request as LongVideoRequest)) !== JSON.stringify(immutableResearchSettings(request))) incompatible("the question, mode, language, quality or research plan changed. Start a new session.");
  if (!sameWindow(savedPlan.requested_window, plan.requested_window) || JSON.stringify(savedPlan.overview_windows) !== JSON.stringify(plan.overview_windows) || savedPlan.segment_seconds !== plan.segment_seconds || savedPlan.max_detail_windows !== plan.max_detail_windows || savedPlan.detail_window_seconds !== plan.detail_window_seconds) incompatible("the source window or plan changed.");
  const overview = previous.segments.filter((s) => s.phase === "overview"), details = previous.segments.filter((s) => s.phase === "detail");
  if (overview.length !== plan.overview_windows.length || overview.some((s, i) => s.id !== `overview:${i + 1}` || !sameWindow(s.window, plan.overview_windows[i]))) incompatible("overview identities or windows are invalid.");
  if (details.length > plan.max_detail_windows || details.some((s, i) => s.id !== `detail:${i + 1}` || !Number.isFinite(s.window.start_seconds) || !Number.isFinite(s.window.end_seconds) || s.window.end_seconds <= s.window.start_seconds || s.window.end_seconds - s.window.start_seconds > plan.detail_window_seconds || !plan.overview_windows.some((w) => s.window.start_seconds >= w.start_seconds && s.window.end_seconds <= w.end_seconds))) incompatible("detail identities or windows are invalid.");
  const ids = new Set<string>(), evidence = new Map<string, Evidence>();
  for (const item of previous.evidence) {
    if (evidence.has(item.id)) incompatible("duplicate evidence IDs.");
    evidence.set(item.id, item);
  }
  if (previous.follow_up) {
    if (!["language", "multimodal"].includes(request.mode)) incompatible("follow-up mode must use language materials.");
    if (request.mode === "language" ? plan.max_detail_windows !== 0 : plan.max_detail_windows < 1) incompatible("follow-up detail planning does not match its mode.");
    const reused = previous.follow_up.reused_evidence_ids;
    if (new Set(reused).size !== reused.length) incompatible("duplicate reused language evidence IDs.");
    for (const id of reused) {
      const item = evidence.get(id), segment = overview.find((s) => s.evidence_ids.includes(id));
      if (!item || !segment || !["caption", "asr"].includes(item.kind) || !item.content?.trim() || item.content.length > 32_000 || item.source.platform !== video.platform || item.source.video_id !== video.id || item.source.part_id !== video.partId || item.source.url !== old.canonicalUrl || item.time_basis !== "source" || !item.time_range || !sameWindow(item.time_range, segment.window)) incompatible("reused language materials are missing, foreign, empty or incorrectly timed.");
    }
    if (overview.some((s) => s.evidence_ids.some((id) => !reused.includes(id)) || s.evidence_ids.length > 1)) incompatible("a follow-up overview must cite its original language evidence only.");
  }
  for (const segment of previous.segments) {
    if (ids.has(segment.id)) incompatible("duplicate segment IDs.");
    ids.add(segment.id);
    if (segment.evidence_ids.some((id) => !id.startsWith(`${segment.id}:`))) incompatible("a segment references another segment's evidence.");
    if (segment.status !== "complete") continue;
    if (!segment.analysis?.trim() || !segment.evidence_ids.length || new Set(segment.evidence_ids).size !== segment.evidence_ids.length) incompatible("a completed segment has no valid report or citations.");
    const primary = segment.evidence_ids.map((id) => evidence.get(id));
    if (primary.some((e) => !e || !e.id.startsWith(`${segment.id}:`) || e.source.platform !== video.platform || e.source.video_id !== video.id || e.source.part_id !== video.partId || e.source.url !== old.canonicalUrl || e.time_basis !== "source" || !e.time_range || !sameWindow(e.time_range, segment.window))) incompatible("a completed segment cites missing, foreign or incorrectly timed evidence.");
    const kinds = primary.map((e) => e!.kind);
    const languageOnly = request.mode === "language" || (!!previous.follow_up && segment.phase === "overview");
    if (languageOnly ? kinds.length !== 1 || !["caption", "asr"].includes(kinds[0]) || !["captions", "audio"].includes(segment.basis) : request.mode === "vision" ? kinds.length !== 1 || kinds[0] !== "visual" || segment.basis !== "video" : kinds.length !== 2 || !kinds.includes("multimodal") || !kinds.includes("asr") || segment.basis !== "audio_video") incompatible("saved evidence does not match the research mode.");
    if (primary.some((e) => ["caption", "asr"].includes(e!.kind) && !e!.content?.trim())) incompatible("saved language evidence is empty.");
  }
}
