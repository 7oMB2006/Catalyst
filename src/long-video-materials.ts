import type { Evidence, SourceContext } from "./contracts.js";
import type { LongVideoRequest, LongVideoResult } from "./long-video-contracts.js";
import { immutableResearchSettings, validateContinuation } from "./long-video-continuation.js";

function incompatible(message: string): never {
  throw Object.assign(new Error(`Saved materials are incompatible: ${message}`), { code: "SESSION_INCOMPATIBLE" });
}

/** Reuse source text, never the old question's reports, relevance or focus decisions. */
export function prepareFollowUpMaterials(previous: LongVideoResult, request: LongVideoRequest, source: SourceContext, plan: NonNullable<LongVideoResult["plan"]>): Evidence[] {
  if (!previous.plan || !previous.video) incompatible("a source and overview plan are required.");
  const original = previous.request as LongVideoRequest;
  const comparable = { ...request, question: original.question, mode: original.mode, maxDetailWindows: original.maxDetailWindows, detailWindowSeconds: original.detailWindowSeconds };
  if (JSON.stringify(immutableResearchSettings(original)) !== JSON.stringify(immutableResearchSettings(comparable))) incompatible("language, quality, interval or overview settings changed.");
  validateContinuation(previous, original, source, { ...plan, max_detail_windows: previous.plan.max_detail_windows, detail_window_seconds: previous.plan.detail_window_seconds });
  const evidence = new Map(previous.evidence.map((item) => [item.id, item]));
  return previous.segments.filter((segment) => segment.phase === "overview" && segment.status === "complete").flatMap((segment) => {
    const language = segment.evidence_ids.map((id) => evidence.get(id)!).filter((item) => ["caption", "asr"].includes(item.kind));
    if (language.some((item) => item.content!.length > 32_000)) incompatible("language material exceeds the bounded per-window text budget.");
    return language.map((item) => ({ ...structuredClone(item), limitations: [...item.limitations, "Reused original language evidence from the parent research; no new transcription or visual inspection of this overview window."] }));
  });
}
