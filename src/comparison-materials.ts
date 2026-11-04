import type { Evidence, ExecutionContext, Finding, ResearchResult } from "./contracts.js";
import type { NoteEvidence, NoteResearchResult, XiaohongshuResearchResult } from "./note-contracts.js";
import type { ComparisonEvidence, ComparisonInput, ComparisonMaterial, PreparedComparison } from "./comparison-contracts.js";
import { researchResultSchema } from "./result-schema.js";
import { noteResearchResultSchema, xiaohongshuResearchResultSchema } from "./note-result-schema.js";
import { ResearchSessionStore } from "./research-session-store.js";
import { redactSensitiveText } from "./video-analysis.js";

const MAX_MATERIAL_EVIDENCE = 80, MAX_EVIDENCE = 200, MAX_TEXT = 32_000;
const rawVideo = new Set(["caption", "asr"]), visual = new Set(["visual", "multimodal", "image_visual"]);
function invalid(message: string, code = "MATERIAL_INVALID"): never { throw Object.assign(new Error(message), { code }); }
function check(context: ExecutionContext): void {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadlineMs) throw new DOMException("Material preparation deadline expired.", "TimeoutError");
}
const safe = (value: string) => redactSensitiveText(value);
const normalizedId = (platform: string, id: string) => platform === "xiaohongshu" ? id.toLowerCase() : platform === "bilibili" && /^BV/i.test(id) ? `BV${id.slice(2)}` : id;
const sourceGroup = (platform: string, id: string) => platform === "xiaohongshu" ? `xiaohongshu:note:${normalizedId(platform, id)}` : `${platform}:video:${normalizedId(platform, id)}`;
function identifier(value: string): void {
  if (!value.trim() || value.length > 256 || safe(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid("A material has an invalid evidence or finding identifier.");
}

/** Source URLs are checked locally; access parameters are never comparison evidence. */
function canonical(raw: string, platform: string, id: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { invalid("A material has an invalid canonical source URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) invalid("A material has an unsupported source URL.");
  const host = url.hostname.toLowerCase();
  if (platform === "bilibili") {
    const match = url.pathname.match(/^\/video\/(BV[\da-z]{10})\/?$/i);
    if (!["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(host) || !match || normalizedId(platform, match[1]) !== normalizedId(platform, id)) invalid("The material URL does not match its Bilibili identity.");
    const parts = url.searchParams.getAll("p");
    if (parts.length > 1 || (parts.length === 1 && (!/^\d+$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0])) || Number(parts[0]) < 1))) invalid("A material has an invalid selected-part URL.");
    const part = parts.length ? Number(parts[0]) : 1;
    return `https://www.bilibili.com/video/${normalizedId(platform, id)}/${part === 1 ? "" : `?p=${part}`}`;
  }
  if (platform === "youtube") {
    let fromUrl: string | null = null;
    if (host === "youtu.be") fromUrl = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1] ?? null;
    else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) fromUrl = url.searchParams.get("v");
      else fromUrl = url.pathname.match(/^\/(?:shorts|embed)\/([\w-]+)\/?$/)?.[1] ?? null;
    }
    if (!/^[\w-]{6,32}$/.test(id) || fromUrl !== id) invalid("The material URL does not match its YouTube identity.");
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (platform === "xiaohongshu") {
    const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i);
    if (!["xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com"].includes(host) || !match || match[1].toLowerCase() !== id.toLowerCase()) invalid("The material URL does not match its Xiaohongshu identity.");
    return `https://www.xiaohongshu.com/explore/${id.toLowerCase()}`;
  }
  invalid("The material platform is unsupported.");
}
function text(value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) invalid("A reusable language evidence item has no text.");
  if (value.length > MAX_TEXT) invalid("A material evidence text exceeds 32,000 characters.", "MATERIAL_BUDGET_EXCEEDED");
  return safe(value.trim());
}
function unique<T extends { id: string }>(items: T[], what: string): Map<string, T> {
  const values = new Map<string, T>();
  for (const item of items) { identifier(item.id); if (values.has(item.id)) invalid(`A material has duplicate ${what} identifiers.`); values.set(item.id, item); }
  return values;
}
function findings(items: Finding[], evidence: Map<string, Evidence | NoteEvidence>): void {
  unique(items, "finding");
  for (const item of items) {
    if (!item.statement.trim() || !item.evidence_ids.length || new Set(item.evidence_ids).size !== item.evidence_ids.length || item.evidence_ids.some((id) => !evidence.has(id))) invalid("A material finding has missing, duplicate or foreign evidence references.");
  }
}
function locator(url: string, platform: string, id: string, part: string | null, item: Evidence | NoteEvidence): ComparisonEvidence["locator"] {
  return { url, platform, content_id: id, part_id: part, time_range: "time_range" in item ? item.time_range : null, page: "page" in item ? item.page : null };
}
function transfer(material: ComparisonMaterial, item: Evidence | NoteEvidence, content: string, basis: ComparisonEvidence["basis"], location: ComparisonEvidence["locator"], finding?: Finding): ComparisonEvidence {
  return {
    id: finding ? `${material.id}:finding:${encodeURIComponent(finding.id)}:${encodeURIComponent(item.id)}` : `${material.id}:text:${encodeURIComponent(item.id)}`,
    material_id: material.id, original_id: item.id, kind: item.kind, basis, content,
    locator: location,
    limitations: [...item.limitations.map(safe), ...(finding ? [...finding.limitations.map(safe), `Unverified derived observation from original finding ${finding.id}; its original references were ${finding.evidence_ids.join(", ")}. The original media is not present and has not been re-inspected for this comparison.`] : [])],
  };
}
function inherited(material: ComparisonMaterial, result: ResearchResult | NoteResearchResult): void {
  material.original_question = safe(result.request.question).slice(0, 2000);
  material.limitations.push(...result.warnings.map(safe));
  material.errors.push(...result.errors.map((e) => ({ code: e.code, message: safe(e.message) })));
  if (result.status !== "complete") material.limitations.push(`The original research was ${result.status}; absence from the retained material does not establish that the source did not discuss a topic.`);
  material.status = result.status === "complete" && !result.errors.length ? "ready" : "partial";
}
function collect(material: ComparisonMaterial, result: ResearchResult | NoteResearchResult, evidence: Map<string, Evidence | NoteEvidence>, question: string, location: (e: Evidence | NoteEvidence) => ComparisonEvidence["locator"]): ComparisonEvidence[] {
  const output: ComparisonEvidence[] = [];
  const sameQuestion = result.request.question.trim() === question.trim();
  for (const item of evidence.values()) {
    if (rawVideo.has(item.kind) || ["note_text", "image_text"].includes(item.kind)) output.push(transfer(material, item, text(item.content), "source_text", location(item)));
  }
  const visualItems = [...evidence.values()].filter((e) => visual.has(e.kind));
  if (visualItems.length && !sameQuestion) {
    material.status = "partial";
    material.limitations.push("The question changed. Old visual findings and image observations were excluded; re-inspect the relevant images or video windows for new visual claims.");
  } else if (sameQuestion) {
    for (const finding of result.findings) {
      if (finding.evidence_ids.some((id) => ["metadata", "community"].includes(evidence.get(id)!.kind))) {
        material.limitations.push("An old finding citing metadata or community opinion was excluded from visual comparison evidence.");
        continue;
      }
      const referenced = finding.evidence_ids.map((id) => evidence.get(id)!);
      const firstVisual = referenced.find((e) => visual.has(e.kind));
      if (!firstVisual) continue;
      const retained = location(firstVisual);
      if (referenced.some((e) => JSON.stringify(location(e)) !== JSON.stringify(retained))) {
        material.status = "partial";
        material.limitations.push(`Original visual finding ${finding.id} joined several time windows or image pages. It was excluded rather than assigned to a single locator; inspect its original joint references or re-read the media.`);
        continue;
      }
      output.push(transfer(material, firstVisual, text(finding.statement), "derived_observation", retained, finding));
    }
  }
  if (output.length > MAX_MATERIAL_EVIDENCE) invalid("The material exceeds 80 comparison evidence items.", "MATERIAL_BUDGET_EXCEEDED");
  return output;
}

function videoMaterial(material: ComparisonMaterial, input: unknown, question: string): ComparisonEvidence[] {
  const parsed = researchResultSchema.safeParse(input);
  if (!parsed.success) invalid("The supplied material is not a supported video research result.");
  const request = parsed.data.request;
  if (typeof request.question !== "string" || !request.question.trim() || typeof request.url !== "string" || !request.url.trim() || typeof request.mode !== "string" || !["language", "vision", "multimodal"].includes(request.mode)) invalid("The material has invalid original video research settings.");
  const result = parsed.data as unknown as ResearchResult, source = result.video;
  if (!source) invalid("The video research has no resolved source.", "MATERIAL_UNAVAILABLE");
  identifier(source.id); if (source.partId !== undefined) identifier(source.partId);
  if (!Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0) invalid("The material has an invalid video duration.");
  const url = canonical(source.canonicalUrl, source.platform, source.id);
  material.title = safe(source.title).slice(0, 1000); material.url = url;
  material.source_group = sourceGroup(source.platform, source.id);
  material.source_key = `${material.source_group}:part:${source.partId ?? (new URL(url).searchParams.get("p") ?? "unspecified")}`;
  inherited(material, result);
  if (result.evidence.length > MAX_MATERIAL_EVIDENCE) invalid("The material exceeds 80 source evidence items.", "MATERIAL_BUDGET_EXCEEDED");
  const evidence = unique(result.evidence, "evidence");
  const start = result.request.startSeconds ?? 0, end = result.request.endSeconds ?? source.durationSeconds;
  if ((result.request.startSeconds === undefined) !== (result.request.endSeconds === undefined) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > source.durationSeconds) invalid("The material has an invalid selected video interval.");
  for (const item of evidence.values()) {
    if (item.source.platform !== source.platform || normalizedId(source.platform, item.source.video_id) !== normalizedId(source.platform, source.id) || item.source.part_id !== source.partId || canonical(item.source.url, source.platform, source.id) !== url) invalid("A material evidence item belongs to a foreign video or selected part.");
    if (["metadata", "community"].includes(item.kind)) continue;
    const range = item.time_range;
    if (item.time_basis !== "source" || !range || !Number.isFinite(range.start_seconds) || !Number.isFinite(range.end_seconds) || range.start_seconds < 0 || range.end_seconds <= range.start_seconds || range.end_seconds > source.durationSeconds || (item.kind === "caption" ? range.end_seconds <= start || range.start_seconds >= end : range.start_seconds < start || range.end_seconds > end)) invalid("A material evidence item has an invalid or out-of-range source interval.");
  }
  findings(result.findings, evidence);
  material.limitations.push(`Retained video research interval: ${start}–${end} source seconds. Only the cited evidence intervals are available; video frames are not present.`);
  return collect(material, result, evidence, question, (item) => locator(url, source.platform, normalizedId(source.platform, source.id), source.partId ?? null, item));
}
function noteMaterial(material: ComparisonMaterial, input: unknown, question: string): ComparisonEvidence[] {
  const parsed = noteResearchResultSchema.safeParse(input);
  if (!parsed.success) invalid("The supplied material is not a supported image-note research result.");
  const result = parsed.data as NoteResearchResult, source = result.note;
  if (!source) invalid("The note research has no resolved source.", "MATERIAL_UNAVAILABLE");
  if (!result.request.question.trim() || !result.request.url.trim()) invalid("The material has invalid original note research settings.");
  identifier(source.id);
  const url = canonical(source.canonicalUrl, source.platform, source.id);
  material.title = safe(source.title).slice(0, 1000); material.url = url;
  material.source_key = material.source_group = sourceGroup(source.platform, source.id);
  inherited(material, result);
  if (result.evidence.length > MAX_MATERIAL_EVIDENCE) invalid("The material exceeds 80 source evidence items.", "MATERIAL_BUDGET_EXCEEDED");
  const evidence = unique(result.evidence, "evidence"), start = result.request.startPage ?? 1, end = result.request.endPage ?? source.imageCount;
  if ((result.request.startPage === undefined) !== (result.request.endPage === undefined) || (result.request.startPage !== undefined && (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > source.imageCount))) invalid("The material has an invalid selected page range.");
  for (const item of evidence.values()) {
    if (item.source.platform !== "xiaohongshu" || normalizedId(source.platform, item.source.note_id) !== normalizedId(source.platform, source.id) || canonical(item.source.url, source.platform, source.id) !== url) invalid("A material evidence item belongs to a foreign note.");
    if (item.kind === "note_text" ? item.page !== null || result.request.startPage !== undefined : item.page === null || !Number.isInteger(item.page) || item.page < start || item.page > end) invalid("A material evidence item has an invalid or out-of-range image page.");
  }
  findings(result.findings, evidence);
  material.limitations.push(`Retained note page range: ${source.imageCount ? `${start}–${end}` : "no image pages"}. OCR and generated image observations are not independent verification.`);
  return collect(material, result, evidence, question, (item) => locator(url, source.platform, normalizedId(source.platform, source.id), null, item));
}

/** Normalize provided, already-read material only; no source/media/provider work is performed. */
export async function prepareComparisonMaterials(inputs: ComparisonInput[], question: string, context: ExecutionContext): Promise<PreparedComparison> {
  const result: PreparedComparison = { materials: [], evidence: [] }, groups = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    check(context);
    const material: ComparisonMaterial = { id: `material:${index + 1}`, label: safe(typeof input?.label === "string" && input.label.trim() || `Material ${index + 1}`).slice(0, 160), status: "unavailable", source_key: null, source_group: null, duplicate_of: null, title: null, url: null, original_question: null, evidence_ids: [], limitations: [], errors: [] };
    try {
      if (!input || typeof input !== "object") invalid("The supplied material is not a research input.");
      let prepared: ComparisonEvidence[];
      if (input.kind === "session") {
        const record = await new ResearchSessionStore().load(input.session_id); check(context);
        if (JSON.stringify(record.request) !== JSON.stringify(record.result.request)) invalid("The saved material request does not match its result.");
        prepared = videoMaterial(material, record.result, question);
      } else if (input.kind === "video") prepared = videoMaterial(material, input.result, question);
      else if (input.kind === "note") prepared = noteMaterial(material, input.result, question);
      else if (input.kind === "xiaohongshu") {
        const parsed = xiaohongshuResearchResultSchema.safeParse(input.result);
        if (!parsed.success) invalid("The supplied material is not a supported Xiaohongshu research result.");
        const wrapped = parsed.data as XiaohongshuResearchResult;
        if (!wrapped.result || wrapped.content_type === "unknown") invalid("The Xiaohongshu research has no reusable result.", "MATERIAL_UNAVAILABLE");
        prepared = wrapped.content_type === "image_note" ? noteMaterial(material, wrapped.result, question) : videoMaterial(material, wrapped.result, question);
        if (wrapped.status !== "complete" || wrapped.errors.length) {
          material.status = "partial";
          material.errors.push(...wrapped.errors.map((e) => ({ code: e.code, message: safe(e.message) })));
          material.limitations.push("The outer Xiaohongshu research result was incomplete.");
        }
      } else invalid("The supplied material kind is unsupported.");
      check(context);
      if (!prepared.length) invalid("No reusable source text or same-question cited visual findings are available.", "MATERIAL_UNAVAILABLE");
      if (result.evidence.length + prepared.length > MAX_EVIDENCE) invalid("The comparison exceeds 200 evidence items; select smaller material ranges.", "MATERIAL_BUDGET_EXCEEDED");
      material.evidence_ids = prepared.map((e) => e.id); result.evidence.push(...prepared);
    } catch (error) {
      if (context.signal.aborted || (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError") throw error;
      const issue = error as { code?: string; message?: string };
      material.status = "unavailable"; material.evidence_ids = [];
      material.errors.push({ code: typeof issue?.code === "string" ? issue.code : "MATERIAL_INVALID", message: safe(issue?.message ?? "The material could not be prepared.") });
    }
    if (material.source_group) {
      material.duplicate_of = groups.get(material.source_group) ?? null;
      if (!material.duplicate_of) groups.set(material.source_group, material.id);
      else material.limitations.push("This material shares a source group with an earlier input and is not an independent corroborating source.");
    }
    result.materials.push(material);
  }
  return result;
}
