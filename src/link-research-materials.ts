import type { ResearchResult, Finding } from "./contracts.js";
import type { ComparisonInput } from "./comparison-contracts.js";
import type { LongVideoResult } from "./long-video-contracts.js";
import type { NoteResearchResult } from "./note-contracts.js";
import type { LinkResearchAction, LinkResearchSource, LinkResearchTaskRecord, LinkResearchTaskView } from "./link-research-contracts.js";

export type ReadResult = ResearchResult | LongVideoResult | NoteResearchResult;
export function readResult(value: Record<string, unknown> | null): ReadResult | null {
  if (!value) return null;
  return ("content_type" in value ? value.result : value) as ReadResult | null;
}
export function sourceReceipts(record: LinkResearchTaskRecord, source: LinkResearchSource): LinkResearchAction[] {
  return record.actions.filter(a => a.source_id === source.id && a.state === "recorded");
}
export function latestSourceReceipt(record: LinkResearchTaskRecord, source: LinkResearchSource): LinkResearchAction | undefined {
  return sourceReceipts(record, source).at(-1);
}
export function sourceBasis(record: LinkResearchTaskRecord): number[] {
  return record.sources.flatMap(s => { const a = latestSourceReceipt(record, s); return a ? [a.index] : []; });
}
function noteMode(mode: LinkResearchTaskRecord["request"]["mode"]): "text" | "vision" | "combined" {
  return mode === "language" ? "text" : mode === "vision" ? "vision" : "combined";
}

/** Keep each pass's exact evidence and references. Reports retain their actual per-pass scope. */
export function materialForSource(record: LinkResearchTaskRecord, source: LinkResearchSource): ComparisonInput | null {
  const receipts = sourceReceipts(record, source);
  const usable = receipts.filter(a => { const r = readResult(a.result); return r && ("video" in r ? r.video : r.note); });
  const latest = readResult(usable.at(-1)?.result ?? receipts.at(-1)?.result ?? null);
  if (!latest) return null;
  const last = receipts.at(-1), preserved = usable.at(-1) !== last;
  if ("video" in latest) return { kind: "video", result: preserved ? { ...latest, status: "partial", warnings: [...latest.warnings, "The latest read failed to resolve this source. Earlier evidence and its report remain retained; this report predates that failed attempt."] } : latest, label: source.id };
  if (usable.length <= 1) return { kind: "note", result: preserved ? { ...latest, status: "partial", warnings: [...latest.warnings, "The latest read failed to resolve this source. Earlier note evidence and its report remain retained."] } : latest, label: source.id };
  const passes = usable.flatMap(a => { const result = readResult(a.result); return result && "note" in result ? [{ action: a, result }] : []; });
  const evidence: NoteResearchResult["evidence"] = [], findings: Finding[] = [];
  for (const { action, result } of passes) {
    const prefix = `pass:${action.index}:`;
    evidence.push(...result.evidence.map(e => ({ ...e, id: prefix + e.id })));
    findings.push(...result.findings.map(f => ({ ...f, id: prefix + f.id, evidence_ids: f.evidence_ids.map(id => prefix + id) })));
  }
  const request = { ...passes[0].result.request, mode: noteMode(record.request.mode) };
  delete request.startPage; delete request.endPage;
  const merged: NoteResearchResult = {
    ...latest, request, evidence, findings, status: "partial",
    analysis: passes.map(({ action, result }) => `Pass ${action.index + 1} (${result.request.startPage === undefined ? "original whole-note request; see retained evidence for actual coverage" : `pages ${result.request.startPage}–${result.request.endPage}`}):\n${result.analysis ?? "No report was produced for this pass."}`).join("\n\n"),
    warnings: [...new Set([...passes.flatMap(p => p.result.warnings), "This accumulated material preserves separate per-pass reports. These reports are not a new synthesis of the entire note. Use the retained evidence and original page locators when answering.", ...(preserved ? ["The latest read failed to resolve this source; earlier evidence remains retained."] : [])])],
    errors: passes.flatMap(p => p.result.errors),
    processing: { ...latest.processing, duration_ms: passes.reduce((sum, p) => sum + p.result.processing.duration_ms, 0), processed_pages: [...new Set(passes.flatMap(p => p.result.processing.processed_pages ?? []))].sort((a,b) => a-b) },
  };
  return { kind: "note", result: merged, label: source.id };
}
export function isAccessRestricted(result: ReadResult): boolean {
  const caps = "video" in result ? [result.capabilities.metadata, result.capabilities.media] : [result.capabilities.body, result.capabilities.images];
  return caps.some(c => ["blocked", "auth_required"].includes(c.status)) || result.errors.some(e => ["source", "resolve", "acquire", "overview_acquire", "detail_acquire"].includes(e.stage.split("/").at(-1)!) && ["ACCESS_BLOCKED", "AUTH_REQUIRED", "RATE_LIMITED", "HTTP_412"].includes(e.code));
}
export function missingNotePages(result: NoteResearchResult, mode: LinkResearchTaskRecord["request"]["mode"]): Array<{ page: number; mode: "text" | "vision" | "combined" }> {
  const languages = new Set(result.evidence.filter(e => e.kind === "image_text" && e.content?.trim()).map(e => e.page));
  const visuals = new Set(result.evidence.filter(e => e.kind === "image_visual" && e.content?.trim()).map(e => e.page));
  return Array.from({ length: Math.min(result.note?.imageCount ?? 0, 10_000) }, (_, index) => index + 1).flatMap(page => {
    const l = mode !== "vision" && !languages.has(page), v = mode !== "language" && !visuals.has(page);
    return l || v ? [{ page, mode: l && v ? "combined" as const : l ? "text" as const : "vision" as const }] : [];
  });
}
export function sourceProgress(record: LinkResearchTaskRecord, source: LinkResearchSource): LinkResearchTaskView["progress"][number] {
  const receipt = latestSourceReceipt(record, source), material = materialForSource(record, source);
  if (!receipt) return { source_id: source.id, status: "pending", can_continue: true, reason: "not_started" };
  const result = material && material.kind !== "session" ? material.result : null;
  if (!result || !("video" in result || "note" in result) || !("video" in result ? result.video : result.note)) return { source_id: source.id, status: "unavailable", can_continue: false, reason: "source_unavailable" };
  const latest = readResult(receipt.result);
  if (!latest || !("video" in latest ? latest.video : latest.note)) return { source_id: source.id, status: "partial", can_continue: false, reason: "latest_source_read_unavailable" };
  if (isAccessRestricted(latest)) return { source_id: source.id, status: "partial", can_continue: false, reason: "source_access_restricted" };
  if ("video" in result) {
    const long = result as LongVideoResult;
    if (long.plan) {
      const incomplete = !long.coverage.overview_complete || long.coverage.unreviewed.length > 0 || long.segments.some(s => s.status !== "complete") || !long.analysis?.trim();
      return { source_id: source.id, status: incomplete ? "partial" : "complete", can_continue: incomplete && !!long.session, reason: incomplete ? long.session ? "saved_video_has_unfinished_work" : "video_session_unavailable" : "planned_video_coverage_complete" };
    }
    return { source_id: source.id, status: result.status, can_continue: false, reason: result.status === "complete" ? "source_read_complete" : "video_session_unavailable" };
  }
  const missing = missingNotePages(result, record.request.mode);
  const reported = sourceReceipts(record, source).some(a => readResult(a.result)?.analysis?.trim());
  if (!missing.length && (!reported || !result.evidence.some(e => e.content?.trim()))) return { source_id: source.id, status: "partial", can_continue: false, reason: "note_report_unavailable" };
  return { source_id: source.id, status: missing.length ? "partial" : "complete", can_continue: missing.length > 0, reason: missing.length ? "note_pages_unread" : "requested_note_channels_retained" };
}
