import { createHash } from "node:crypto";
import type { ResearchResult } from "./contracts.js";
import type { NoteResearchResult } from "./note-contracts.js";
import type { ComparisonInput } from "./comparison-contracts.js";
import type { LinkResearchTaskRecord, LinkResearchSource } from "./link-research-contracts.js";
import { researchResultSchema } from "./result-schema.js";
import { noteResearchResultSchema } from "./note-result-schema.js";
import { getAdapter } from "./adapters/index.js";
import { canonicalResearchSourceUrl } from "./comparison-materials.js";
import { canonicalResearchInputUrl, isResearchShareUrl, validateSourceEvidence } from "./research-source-evidence.js";

type Material = Extract<ComparisonInput, { kind: "video" | "note" }>;
function invalid(): never { throw Object.assign(new Error("A follow-up snapshot has invalid source text, identity or provenance."), { code: "TASK_CORRUPT" }); }
const warning = "Reused source text from a saved parent task. No acquisition, transcription, OCR or visual inspection was performed for this snapshot. Its original retained scope and uncertainty remain in force.";

/** Strip question-specific products before storing a self-contained child input. */
export function snapshotSourceText(input: ComparisonInput | null): Material | null {
  if (!input || input.kind === "session") return null;
  const leaf = input.kind === "xiaohongshu" ? input.result.result : input.result;
  if (!leaf || !("video" in leaf ? leaf.video : leaf.note)) return null;
  const common = { status: leaf.status, findings: [], analysis: null, warnings: [warning, ...(leaf.status === "complete" ? [] : [`The parent research was ${leaf.status}; only its retained text is available.`])],
    errors: leaf.errors.map(e => ({ ...e, message: "A processing issue was recorded by the parent; this snapshot preserves only its retained source text." })),
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: null, usage: null } };
  if ("video" in leaf) {
    const result = researchResultSchema.parse(leaf) as unknown as ResearchResult;
    const { metadata: _metadata, ...identity } = result.video!;
    return { kind: "video", ...(input.label ? { label: input.label } : {}), result: { ...result, ...common, video: identity,
      request: { url: result.request.url, question: result.request.question, mode: result.request.mode, ...(result.request.language ? { language: result.request.language } : {}), ...(result.request.startSeconds !== undefined ? { startSeconds: result.request.startSeconds, endSeconds: result.request.endSeconds } : {}) },
      evidence: result.evidence.filter(e => ["caption", "asr"].includes(e.kind) && e.content?.trim()),
    } };
  }
  const result = noteResearchResultSchema.parse(leaf) as NoteResearchResult;
  return { kind: "note", ...(input.label ? { label: input.label } : {}), result: { ...result, ...common,
    request: { url: result.request.url, question: result.request.question, mode: result.request.mode, ...(result.request.language ? { language: result.request.language } : {}), ...(result.request.startPage !== undefined ? { startPage: result.request.startPage, endPage: result.request.endPage } : {}) },
    evidence: result.evidence.filter(e => ["note_text", "image_text"].includes(e.kind) && e.content?.trim()),
  } };
}

export function validateFollowUpSnapshots(record: LinkResearchTaskRecord): void {
  if (!record.follow_up) return;
  for (const [index, snapshot] of record.follow_up.snapshots.entries()) {
    const source = record.sources[index];
    if (!source || source.id !== snapshot.source_id) invalid();
    const material = snapshot.material;
    if (!material) continue;
    if (material.kind !== "video" && material.kind !== "note") invalid();
    const raw = material.result as ResearchResult | NoteResearchResult;
    const result = (material.kind === "video" ? researchResultSchema.strict().parse(raw) : noteResearchResultSchema.strict().parse(raw)) as unknown as ResearchResult | NoteResearchResult;
    if (result.analysis !== null || result.findings.length || typeof result.request.question !== "string" || !result.request.question.trim() || typeof result.request.url !== "string") invalid();
    if (!(material.kind === "video" ? ["language", "vision", "multimodal"] : ["text", "vision", "combined"]).includes(result.request.mode ?? "text")) invalid();
    const identity = "video" in result ? result.video : result.note;
    if (!identity || getAdapter(source.url).platform !== identity.platform) invalid();
    const canonical = canonicalResearchSourceUrl(identity.canonicalUrl, identity.platform, identity.id);
    const selected = canonicalResearchInputUrl(source.url, identity);
    if (selected ? selected !== canonical : !isResearchShareUrl(source.url)) invalid();
    const requested = canonicalResearchInputUrl(result.request.url, identity);
    if (requested ? requested !== canonical : result.request.url !== source.url) invalid();
    if (result.evidence.some(e => !("video" in result ? ["caption", "asr"] : ["note_text", "image_text"]).includes(e.kind) || !e.content?.trim())) invalid();
    validateSourceEvidence(result as ResearchResult | NoteResearchResult);
  }
}

export function sourceSnapshot(record: LinkResearchTaskRecord, source: LinkResearchSource): Material | null {
  const material = record.follow_up?.snapshots.find(s => s.source_id === source.id)?.material;
  return material && (material.kind === "video" || material.kind === "note") ? material : null;
}

/** The hash includes immutable seed inputs as well as any new source receipts. */
export function researchMaterialsHash(materials: ComparisonInput[]): string {
  return createHash("sha256").update(JSON.stringify(materials)).digest("hex");
}

/** New visuals and reused language stay in separate namespaces with original locators. */
export function mergeFollowUpMaterial(record: LinkResearchTaskRecord, source: LinkResearchSource, fresh: ComparisonInput | null): ComparisonInput | null {
  const seed = sourceSnapshot(record, source);
  if (record.request.mode === "language") return seed;
  const attempted = record.actions.some(a => a.source_id === source.id && a.state === "recorded");
  if (!fresh || fresh.kind === "session" || fresh.kind === "xiaohongshu" || !("video" in fresh.result ? fresh.result.video : fresh.result.note)) {
    if (!seed) return null;
    return { ...seed, result: { ...seed.result, evidence: record.request.mode === "vision" ? [] : seed.result.evidence, findings: [], analysis: null,
      ...(attempted ? { status: "partial", warnings: [...seed.result.warnings, "The new visual pass did not resolve this source. Earlier raw source text remains available; no new visual evidence was obtained."] } : {}),
    } } as Material;
  }
  const result = "video" in fresh.result ? researchResultSchema.parse(fresh.result) : noteResearchResultSchema.parse(fresh.result);
  const previous = seed?.result;
  const raw = record.request.mode === "multimodal" && previous ? previous.evidence : [];
  const reused = raw.map(e => ({ ...e, id: `reused:${e.id}` }));
  const inspected = result.evidence.map(e => ({ ...e, id: `inspected:${e.id}` }));
  const request = { ...result.request };
  const findings = result.findings.map(f => ({ ...f, id: `inspected:${f.id}`, evidence_ids: f.evidence_ids.map(id => `inspected:${id}`) }));
  const completeText = record.request.mode !== "multimodal" || !!previous?.evidence.length && previous.status === "complete";
  const merged = { ...result, request, evidence: [...reused, ...inspected], findings, status: result.status === "complete" && completeText ? "complete" as const : "partial" as const,
    warnings: [...result.warnings, ...(seed ? seed.result.warnings : []), "Retained source text and new visual evidence are combined for this question. The visual pass report alone is not a synthesis of both channels."],
  };
  if ("video" in result) {
    merged.request = { ...request, mode: record.request.mode };
    return { kind: "video", label: source.id, result: researchResultSchema.parse(merged) as unknown as ResearchResult };
  }
  merged.request = { ...request, mode: record.request.mode === "multimodal" ? "combined" : "vision" };
  delete (merged.request as NoteResearchResult["request"]).startPage; delete (merged.request as NoteResearchResult["request"]).endPage;
  return { kind: "note", label: source.id, result: noteResearchResultSchema.parse(merged) as NoteResearchResult };
}
