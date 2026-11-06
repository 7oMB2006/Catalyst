import type { ResearchResult } from "./contracts.js";
import type { NoteResearchResult } from "./note-contracts.js";
import { parseSourceUrl } from "./adapters/index.js";
import { canonicalResearchSourceUrl } from "./comparison-materials.js";

type MaterialResult = ResearchResult | NoteResearchResult;
const normalizedId = (platform: string, id: string) => platform === "xiaohongshu" ? id.toLowerCase() : platform === "bilibili" ? id.replace(/^bv/i, "BV") : id;
function mismatch(): never { throw Object.assign(new Error("The retained evidence does not match its source or locator contract."), { code: "TASK_RESULT_MISMATCH" }); }

export function canonicalResearchInputUrl(raw: string, identity: { platform: string; id: string }): string | null {
  try { return canonicalResearchSourceUrl(parseSourceUrl(raw).toString(), identity.platform, identity.id); }
  catch { return null; }
}
export function isResearchShareUrl(raw: string): boolean {
  return ["b23.tv", "www.b23.tv", "xhslink.com", "www.xhslink.com", "xhslink.cn", "www.xhslink.cn"].includes(parseSourceUrl(raw).hostname);
}

/** Source validation has no comparison-context limit: completed evidence is not truncated. */
export function validateSourceEvidence(result: MaterialResult): void {
  const source = "video" in result ? result.video : result.note;
  if (!source) { if (result.status === "complete" || result.evidence.length) mismatch(); return; }
  const url = canonicalResearchSourceUrl(source.canonicalUrl, source.platform, source.id);
  if ("video" in result ? !Number.isFinite(result.video!.durationSeconds) || result.video!.durationSeconds <= 0 : !Number.isInteger(result.note!.imageCount) || result.note!.imageCount < 0 || result.note!.imageCount > 10_000) mismatch();
  const ids = new Set<string>();
  for (const item of result.evidence) {
    if (!item.id.trim() || ids.has(item.id)) mismatch(); ids.add(item.id);
    const identity = item.source;
    const id = "video_id" in identity ? identity.video_id : identity.note_id;
    const part = "video_id" in identity ? identity.part_id : undefined;
    if (identity.platform !== source.platform || normalizedId(source.platform, id) !== normalizedId(source.platform, source.id) || part !== ("video" in result ? result.video!.partId : undefined) || canonicalResearchSourceUrl(identity.url, source.platform, source.id) !== url) mismatch();
    if ("page" in item) {
      if (!("note" in result)) mismatch();
      if (item.kind === "note_text" ? item.page !== null || result.request.startPage !== undefined : item.page === null || item.page < (result.request.startPage ?? 1) || item.page > (result.request.endPage ?? result.note!.imageCount)) mismatch();
    } else if (!["metadata", "community"].includes(item.kind)) {
      if (!("video" in result) || item.time_basis !== "source" || !item.time_range || item.time_range.start_seconds < 0 || item.time_range.end_seconds <= item.time_range.start_seconds || item.time_range.end_seconds > result.video!.durationSeconds) mismatch();
    }
  }
  const findings = new Set<string>();
  for (const finding of result.findings) {
    if (findings.has(finding.id) || !finding.evidence_ids.length || new Set(finding.evidence_ids).size !== finding.evidence_ids.length || finding.evidence_ids.some(id => !ids.has(id))) mismatch();
    findings.add(finding.id);
  }
}
