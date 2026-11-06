import type { ComparisonInput, ComparisonResult } from "./comparison-contracts.js";
import type { LinkResearchAction, LinkResearchSource, LinkResearchTaskRecord } from "./link-research-contracts.js";
import type { LongVideoResult } from "./long-video-contracts.js";
import { getAdapter, parseSourceUrl } from "./adapters/index.js";
import { canonicalResearchSourceUrl, prepareComparisonMaterials } from "./comparison-materials.js";
import { validateLongPlan } from "./followup-plan-materials.js";
import { readResult, materialForSource } from "./link-research-materials.js";
import { parseLinkActionResult } from "./link-research-schema.js";

function mismatch(): never { throw Object.assign(new Error("The research receipt does not match its saved source, question or evidence contract."), { code: "TASK_RESULT_MISMATCH" }); }
const context = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
const normalizedSourceId = (platform: string, id: string): string => platform === "xiaohongshu" ? id.toLowerCase()
  : platform === "bilibili" ? id.replace(/^bv/i, "BV") : id;
function canonicalInput(raw: string, identity: { platform: string; id: string }): string | null {
  try { return canonicalResearchSourceUrl(parseSourceUrl(raw).toString(), identity.platform, identity.id); }
  catch { return null; }
}
function shortUrl(raw: string): boolean {
  const url = parseSourceUrl(raw);
  return ["b23.tv", "www.b23.tv", "xhslink.com", "www.xhslink.com", "xhslink.cn", "www.xhslink.cn"].includes(url.hostname);
}
export function checkFreshUrl(source: LinkResearchSource, raw: string, record: LinkResearchTaskRecord): void {
  const url = parseSourceUrl(raw), old = parseSourceUrl(source.url), material = materialForSource(record, source);
  const leaf = material && material.kind !== "session" && material.kind !== "xiaohongshu" ? material.result : null;
  const identity = leaf ? "video" in leaf ? leaf.video : leaf.note : null;
  if (identity) {
    if (canonicalInput(url.toString(), identity) === canonicalResearchSourceUrl(identity.canonicalUrl, identity.platform, identity.id)) return;
    // Access parameters can refresh an original short URL without changing its opaque path.
    if (shortUrl(source.url) && url.origin === old.origin && url.pathname === old.pathname) return;
  } else if (url.origin === old.origin && url.pathname === old.pathname && url.searchParams.get("p") === old.searchParams.get("p") && url.searchParams.get("v") === old.searchParams.get("v")) return;
  throw Object.assign(new Error("A fresh URL must name the saved source and selected part. Use the same share URL or its resolved canonical source URL."), { code: "TASK_SOURCE_MISMATCH" });
}

/** Validate receipts without applying the smaller downstream comparison input budget. */
export async function validateLinkReceipt(action: LinkResearchAction, input: unknown, record: LinkResearchTaskRecord, comparisonMaterials?: ComparisonInput[]): Promise<Record<string, unknown>> {
  const value = parseLinkActionResult(action, input);
  if (action.tool === "compare_research_materials") {
    const result = value as unknown as ComparisonResult;
    if (result.question !== record.request.question || !comparisonMaterials) mismatch();
    // Validation/budget/deadline failures may return before material preparation.
    if (result.status === "unavailable" && !result.materials.length && !result.evidence.length && !result.comparisons.length && result.analysis === null && result.errors.length) return value;
    const prepared = await prepareComparisonMaterials(comparisonMaterials, record.request.question, context());
    if (JSON.stringify(result.materials) !== JSON.stringify(prepared.materials) || JSON.stringify(result.evidence) !== JSON.stringify(prepared.evidence)) mismatch();
    const evidence = new Map(result.evidence.map(e => [e.id, e])), materialIds = new Set(result.materials.map(m => m.id));
    for (const row of result.comparisons) {
      const seen = new Set<string>();
      for (const p of row.positions) {
        if (!materialIds.has(p.material_id) || seen.has(p.material_id)) mismatch();
        seen.add(p.material_id);
        if (["supports", "contradicts"].includes(p.stance) && !p.citations.length || ["not_addressed", "insufficient"].includes(p.stance) && p.citations.length) mismatch();
        for (const c of p.citations) { const e = evidence.get(c.evidence_id); if (!e || e.material_id !== p.material_id || !c.quote.trim() || !e.content.includes(c.quote)) mismatch(); }
      }
      if (seen.size !== materialIds.size) mismatch();
    }
    return value;
  }
  const source = record.sources.find(s => s.id === action.source_id);
  if (!source) mismatch();
  const leaf = readResult(value);
  if (!leaf) { if (value.status === "complete") mismatch(); return value; }
  const expectedMode = action.tool === "analyze_xiaohongshu_note" && "note" in leaf ? action.arguments.mode : record.request.mode;
  if (leaf.request.question.trim() !== record.request.question || leaf.request.mode !== expectedMode || leaf.request.language !== record.request.language) mismatch();
  const identity = "video" in leaf ? leaf.video : leaf.note;
  if (!identity) { if (leaf.status === "complete" || leaf.evidence.length) mismatch(); return value; }
  if ("video" in leaf && (!Number.isFinite(leaf.video!.durationSeconds) || leaf.video!.durationSeconds <= 0) || "note" in leaf && (!Number.isInteger(leaf.note!.imageCount) || leaf.note!.imageCount < 0 || leaf.note!.imageCount > 10_000)) mismatch();
  const url = canonicalResearchSourceUrl(identity.canonicalUrl, identity.platform, identity.id);
  if (getAdapter(source.url).platform !== identity.platform) mismatch();
  if (action.arguments.url) {
    const requested = String(action.arguments.url);
    const original = canonicalInput(requested, identity);
    if (original ? original !== url : !shortUrl(requested)) mismatch();
  }
  if (canonicalInput(leaf.request.url, identity) !== url && leaf.request.url !== source.url) mismatch();
  const previous = materialForSource(record, source);
  if (previous && previous.kind !== "session" && previous.kind !== "xiaohongshu") {
    const old = previous.result;
    const oldIdentity = "video" in old ? old.video : old.note;
    if (oldIdentity && (oldIdentity.platform !== identity.platform || normalizedSourceId(identity.platform, oldIdentity.id) !== normalizedSourceId(identity.platform, identity.id) || canonicalResearchSourceUrl(oldIdentity.canonicalUrl, oldIdentity.platform, oldIdentity.id) !== url || ("video" in old ? ! ("video" in leaf) || old.video!.partId !== leaf.video!.partId || old.video!.durationSeconds !== leaf.video!.durationSeconds : !("note" in leaf) || old.note!.imageCount !== leaf.note!.imageCount))) mismatch();
  }
  if (action.tool === "analyze_xiaohongshu_note" && "note" in leaf && (leaf.request.startPage !== action.arguments.start_page || leaf.request.endPage !== action.arguments.end_page)) mismatch();
  if ("video" in leaf) {
    if (!("plan" in leaf)) mismatch();
    const long = leaf as LongVideoResult;
    if (long.plan) validateLongPlan(long, { start_seconds: long.request.startSeconds ?? 0, end_seconds: long.request.endSeconds ?? long.video!.durationSeconds });
    if (action.tool === "resume_long_video_research" && (long.session?.id !== action.arguments.session_id || previous && previous.kind === "video" && (previous.result as LongVideoResult).session?.id !== long.session?.id)) mismatch();
    if (long.request.startSeconds !== undefined || long.request.endSeconds !== undefined) mismatch();
    if (((long.request as { segmentSeconds?: number }).segmentSeconds ?? 600) !== record.request.segmentSeconds || ((long.request as { maxSegments?: number }).maxSegments ?? 12) !== record.request.maxSegments || ((long.request as { maxDetailWindows?: number }).maxDetailWindows ?? 2) !== record.request.maxDetailWindows) mismatch();
  }
  const ids = new Set<string>();
  for (const e of leaf.evidence) {
    if (!e.id.trim() || ids.has(e.id)) mismatch(); ids.add(e.id);
    const eSource = e.source;
    const id = "video_id" in eSource ? eSource.video_id : eSource.note_id;
    const part = "video_id" in eSource ? eSource.part_id : undefined;
    if (eSource.platform !== identity.platform || normalizedSourceId(identity.platform, id) !== normalizedSourceId(identity.platform, identity.id) || part !== ("video" in leaf ? leaf.video!.partId : undefined) || canonicalResearchSourceUrl(eSource.url, identity.platform, identity.id) !== url) mismatch();
    if ("page" in e) {
      if (!("note" in leaf)) mismatch();
      if (e.kind === "note_text" ? e.page !== null || leaf.request.startPage !== undefined : e.page === null || e.page < (leaf.request.startPage ?? 1) || e.page > (leaf.request.endPage ?? leaf.note!.imageCount)) mismatch();
    } else if (!["metadata", "community"].includes(e.kind)) {
      if (!("video" in leaf) || e.time_basis !== "source" || !e.time_range || e.time_range.start_seconds < 0 || e.time_range.end_seconds <= e.time_range.start_seconds || e.time_range.end_seconds > leaf.video!.durationSeconds) mismatch();
    }
  }
  const findingIds = new Set<string>();
  for (const f of leaf.findings) {
    if (findingIds.has(f.id) || !f.evidence_ids.length || new Set(f.evidence_ids).size !== f.evidence_ids.length || f.evidence_ids.some(id => !ids.has(id))) mismatch();
    findingIds.add(f.id);
  }
  return value;
}
