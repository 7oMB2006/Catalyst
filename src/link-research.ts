import type { ComparisonInput, ComparisonResult } from "./comparison-contracts.js";
import type { LongVideoRequest, LongVideoResult } from "./long-video-contracts.js";
import type { LinkResearchAction, LinkResearchRequest, NormalizedLinkResearchRequest, ContinueLinkResearchRequest, LinkResearchSource, LinkResearchTaskOptions, LinkResearchTaskRecord, LinkResearchTaskView } from "./link-research-contracts.js";
import type { ResearchTaskHost } from "./research-task-contracts.js";
import { getAdapter, parseSourceUrl } from "./adapters/index.js";
import { startLongVideoResearch, resumeLongVideoResearch, sanitizeResearchSnapshot, sessionCompatibility } from "./research-sessions.js";
import { ResearchSessionStore, type ResearchSessionRecord } from "./research-session-store.js";
import { researchXiaohongshuNote } from "./note-research.js";
import { compareResearchMaterials } from "./comparison.js";
import { canonicalResearchSourceUrl } from "./comparison-materials.js";
import { linkResearchRequestSchema, continueLinkResearchRequestSchema, linkActionKey, parseLinkResearchTaskRecord } from "./link-research-schema.js";
import { LinkResearchTaskStore } from "./link-research-store.js";
import { latestSourceReceipt, materialForSource, missingNotePages, readResult, sourceBasis, sourceProgress } from "./link-research-materials.js";
import { checkFreshUrl, validateLinkReceipt } from "./link-research-receipts.js";

const now = () => new Date().toISOString();
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function publicSource(raw: string): string { return sanitizeResearchSnapshot({ url: parseSourceUrl(raw).toString() }).url; }
function videoRequest(args: Record<string, unknown>): LongVideoRequest {
  return { url: args.url as string, question: args.question as string, mode: args.mode as LongVideoRequest["mode"], language: args.language as string | undefined,
    segmentSeconds: args.segment_seconds as number, maxSegments: args.max_segments as number, maxDetailWindows: args.max_detail_windows as number,
    detailWindowSeconds: args.detail_window_seconds as number, maxDownloadMB: args.max_download_mb as number,
    windowTimeoutSeconds: args.window_timeout_seconds as number, timeoutSeconds: args.timeout_seconds as number };
}
/** Direct adapters keep the MCP server a bounded workflow, without recursively spawning itself. */
export function createLinkResearchHost(request: NormalizedLinkResearchRequest): ResearchTaskHost {
  return { async callTool(name, args, signal) {
    if (name === "analyze_long_video_url") return startLongVideoResearch(videoRequest(args), { signal });
    if (name === "resume_long_video_research") return resumeLongVideoResearch(args.session_id as string, { url: args.url as string | undefined, timeoutSeconds: args.timeout_seconds as number, windowTimeoutSeconds: args.window_timeout_seconds as number, maxDownloadMB: args.max_download_mb as number }, { signal });
    if (name === "analyze_xiaohongshu_note") return researchXiaohongshuNote({ url: args.url as string, question: args.question as string, mode: args.mode as "text" | "vision" | "combined", language: args.language as string | undefined, startPage: args.start_page as number | undefined, endPage: args.end_page as number | undefined, timeoutSeconds: args.timeout_seconds as number }, {
      // Confirmed video notes receive the same resumable long-video path as other links.
      video: (url, question, mode, context, language) => startLongVideoResearch({ url, question, mode, language, segmentSeconds: request.segmentSeconds, maxSegments: request.maxSegments, maxDetailWindows: request.maxDetailWindows, detailWindowSeconds: 120, windowTimeoutSeconds: Math.min(180, request.actionTimeoutSeconds), maxDownloadMB: 128, timeoutSeconds: Math.max(5, (context.deadlineMs - Date.now()) / 1000) }, { signal: context.signal }),
    }, signal);
    if (name === "compare_research_materials") return compareResearchMaterials({ question: args.question as string, materials: args.materials as ComparisonInput[], language: args.language as string | undefined, timeoutSeconds: args.timeout_seconds as number }, {}, signal);
    return fail("TASK_TOOL_UNSUPPORTED", "This task cannot invoke an unrecognized tool.");
  } };
}

function materials(record: LinkResearchTaskRecord): ComparisonInput[] {
  return record.sources.flatMap(s => { const input = materialForSource(record, s); return input ? [input] : []; });
}
function lastComparisonAttempt(record: LinkResearchTaskRecord): LinkResearchAction | undefined {
  return record.actions.filter(a => a.tool === "compare_research_materials" && a.state === "recorded").at(-1);
}
function currentComparison(record: LinkResearchTaskRecord): { comparison: ComparisonResult | null; comparison_current: boolean } {
  const last = record.actions.filter(a => a.tool === "compare_research_materials" && a.state === "recorded" && (a.result?.comparisons as unknown[] | undefined)?.length).at(-1);
  return { comparison: last?.result as unknown as ComparisonResult ?? null, comparison_current: !!last && JSON.stringify(last.basis) === JSON.stringify(sourceBasis(record)) };
}
function view(record: LinkResearchTaskRecord): LinkResearchTaskView {
  const comparison = currentComparison(record);
  return sanitizeResearchSnapshot({ task: record, progress: record.sources.map(s => sourceProgress(record, s)), materials: materials(record), ...comparison,
    limitations: ["Completion describes bounded reading coverage and recorded calls, not proof that the research question has been fully answered or independently verified.",
      "The total allowance reserves each dispatched call's declared timeout, including comparison. Reservations survive restart and are not refunded; they are not measured elapsed time or a monetary/download budget.",
      "Acquisition URLs with access parameters are used only in memory. A platform may require a fresh URL when continuing.",
      ...(comparison.comparison && !comparison.comparison_current ? ["The saved comparison predates the latest source receipts. Its conclusions have not yet been updated with the new evidence."] : []),
      ...(lastComparisonAttempt(record)?.result?.status === "unavailable" ? ["The latest comparison attempt returned unavailable. Earlier source results and any older comparison remain saved."] : []),
    ] });
}

/** A disk snapshot must still satisfy source and citation contracts before it is trusted. */
async function validateSavedReceipts(record: LinkResearchTaskRecord): Promise<void> {
  try {
    for (const action of record.actions) {
      if (action.state !== "recorded") continue;
      const prefix = { ...record, actions: record.actions.slice(0, action.index) };
      await validateLinkReceipt(action, action.result, prefix, action.tool === "compare_research_materials" ? materials(prefix) : undefined);
    }
  } catch { fail("TASK_CORRUPT", "A saved research receipt has inconsistent source, question, coverage or citation references."); }
}

export async function getLinkResearchTask(id: string, options: LinkResearchTaskOptions = {}): Promise<LinkResearchTaskView> {
  const record = parseLinkResearchTaskRecord(await (options.store ?? new LinkResearchTaskStore()).load(id), id);
  await validateSavedReceipts(record); return view(record);
}

/** Start from the user's links, preserving original acquisition inputs only for this invocation. */
export async function startLinkResearchTask(request: LinkResearchRequest, options: LinkResearchTaskOptions = {}): Promise<LinkResearchTaskView> {
  if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) fail("TASK_TOO_LARGE", "The link research request exceeds 64 KiB.");
  const input = linkResearchRequestSchema.parse(request) as NormalizedLinkResearchRequest;
  options.signal?.throwIfAborted();
  const unique = new Map<string, string>();
  for (const raw of input.urls) { getAdapter(raw); const url = publicSource(raw); if (!unique.has(url)) unique.set(url, parseSourceUrl(raw).toString()); }
  const sources: LinkResearchSource[] = [...unique.keys()].map((url, index) => ({ id: `source:${index + 1}`, url, kind: getAdapter(url).platform === "xiaohongshu" ? "xiaohongshu" : "video" }));
  const store = options.store ?? new LinkResearchTaskStore(), timestamp = now();
  const record = parseLinkResearchTaskRecord({ schema_version: "2", kind: "link_research", id: store.newId(), revision: 1, created_at: timestamp, updated_at: timestamp,
    request: { ...sanitizeResearchSnapshot(input), urls: sources.map(s => s.url) }, sources, actions: [], status: "ready", budget: { max_actions: input.maxActions, attempted_actions: 0, total_timeout_seconds: input.totalTimeoutSeconds, reserved_timeout_seconds: 0 }, stop_reason: "links_saved" });
  await store.withLock(record.id, () => store.save(record, null));
  return continueLinkResearchTask(record.id, { sourceUrls: sources.map(s => ({ sourceId: s.id, url: unique.get(s.url)! })) }, { ...options, store });
}

type Definition = Pick<LinkResearchAction, "tool" | "source_id" | "arguments" | "basis" | "timeout_seconds">;
async function localSessionRefusal(definition: Definition): Promise<"session_unavailable" | "session_incompatible" | null> {
  let saved: ResearchSessionRecord;
  try { saved = await new ResearchSessionStore().load(definition.arguments.session_id as string); }
  catch { return "session_unavailable"; }
  try { return saved.compatibility === sessionCompatibility(saved.request) ? null : "session_incompatible"; }
  catch { return "session_incompatible"; }
}
function sourceDefinition(record: LinkResearchTaskRecord, source: LinkResearchSource, fresh: boolean): Definition | null {
  const request = record.request, previous = latestSourceReceipt(record, source), material = materialForSource(record, source);
  const result = material && material.kind !== "session" && material.kind !== "xiaohongshu" ? material.result : null;
  const progress = sourceProgress(record, source), timeout = request.actionTimeoutSeconds;
  if (previous && !progress.can_continue && !(fresh && progress.status !== "complete")) return null;
  const basis = previous ? [previous.index] : [];
  if (result && "video" in result && (result as LongVideoResult).session) {
    const long = result as LongVideoResult;
    return { tool: "resume_long_video_research", source_id: source.id, basis, timeout_seconds: timeout, arguments: { session_id: long.session!.id, timeout_seconds: timeout, window_timeout_seconds: Math.min(180, timeout), max_download_mb: 128 } };
  }
  let url = source.url;
  const identity = result ? "video" in result ? result.video : result.note : null;
  if (identity) url = canonicalResearchSourceUrl(identity.canonicalUrl, identity.platform, identity.id);
  if (source.kind === "xiaohongshu") {
    let mode = request.mode === "language" ? "text" : request.mode === "vision" ? "vision" : "combined";
    let pages: Record<string, unknown> = {};
    if (result && "note" in result) {
      const missing = missingNotePages(result, request.mode), first = missing[0];
      if (!first) return null;
      mode = first.mode;
      let end = first.page;
      for (const next of missing.slice(1, 5)) { if (next.page !== end + 1 || next.mode !== mode) break; end = next.page; }
      pages = { start_page: first.page, end_page: end };
    }
    return { tool: "analyze_xiaohongshu_note", source_id: source.id, basis, timeout_seconds: timeout, arguments: { url, question: request.question, mode, ...pages, ...(request.language ? { language: request.language } : {}), timeout_seconds: timeout } };
  }
  if (previous && result && "video" in result && result.video) return null;
  return { tool: "analyze_long_video_url", source_id: source.id, basis, timeout_seconds: timeout, arguments: { url, question: request.question, mode: request.mode, ...(request.language ? { language: request.language } : {}), segment_seconds: request.segmentSeconds, max_segments: request.maxSegments, max_detail_windows: request.maxDetailWindows, detail_window_seconds: 120, max_download_mb: 128, window_timeout_seconds: Math.min(180, timeout), timeout_seconds: timeout, save_session: true } };
}

/** The inner engines own their deadline and return structured partial results; allow bounded cleanup. */
async function dispatch(host: ResearchTaskHost, definition: Definition, args: Record<string, unknown>, external?: AbortSignal): Promise<unknown> {
  external?.throwIfAborted();
  const controller = new AbortController(), signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException("The research tool did not acknowledge its result before the cleanup deadline.", "TimeoutError")), (definition.timeout_seconds + 10) * 1000);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { listener = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); signal.addEventListener("abort", listener, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return host.callTool(definition.tool, args, signal); }), aborted]); }
  finally { clearTimeout(timer); if (listener) signal.removeEventListener("abort", listener); }
}

/** Continue the same saved question and cumulative allowance. Unknown dispatches never replay. */
export async function continueLinkResearchTask(id: string, request: ContinueLinkResearchRequest = {}, options: LinkResearchTaskOptions = {}): Promise<LinkResearchTaskView> {
  const runtime = continueLinkResearchRequestSchema.parse(request), store = options.store ?? new LinkResearchTaskStore();
  return store.withLock(id, async () => {
    let record = parseLinkResearchTaskRecord(await store.load(id), id);
    await validateSavedReceipts(record);
    const checkpoint = async () => {
      const prior = record.revision;
      const next = parseLinkResearchTaskRecord(sanitizeResearchSnapshot({ ...record, revision: prior + 1, updated_at: now() }), id);
      await store.save(next, prior); record = next;
    };
    if (record.actions.some(a => a.state === "running")) {
      for (const action of record.actions.filter(a => a.state === "running")) { action.state = "unknown"; action.finished_at = now(); action.error = { code: "OUTCOME_UNKNOWN", message: "The previous process stopped after recording dispatch intent. Inspect the saved research/session before doing more work; this call will not be replayed." }; }
      record.status = "needs_attention"; record.stop_reason = "outcome_unknown"; await checkpoint(); return view(record);
    }
    if (record.actions.some(a => a.state === "unknown")) return view(record);
    const fresh = new Map<string, string>();
    for (const item of runtime.sourceUrls ?? []) {
      const source = record.sources.find(s => s.id === item.sourceId);
      if (!source || fresh.has(item.sourceId)) fail("TASK_SOURCE_MISMATCH", "Supply each saved source identifier at most once.");
      getAdapter(item.url); checkFreshUrl(source, item.url, record); fresh.set(source.id, parseSourceUrl(item.url).toString());
    }
    const host = options.host ?? createLinkResearchHost(record.request), attemptedSources = new Set<string>();
    let stoppedForBudget = false;
    for (let step = 0; step < runtime.maxSteps; step++) {
      if (options.signal?.aborted) { record.status = "cancelled"; record.stop_reason = "cancelled_before_dispatch"; await checkpoint(); return view(record); }
      let definition: Definition | null = null;
      // Give every user-selected link its initial read before supplementing one source.
      const ordered = [...record.sources].sort((a,b) => Number(!!latestSourceReceipt(record,a)) - Number(!!latestSourceReceipt(record,b)));
      for (const source of ordered) {
        if (attemptedSources.has(source.id)) continue;
        definition = sourceDefinition(record, source, fresh.has(source.id));
        if (definition) break;
      }
      const inputs = materials(record), basis = sourceBasis(record);
      if (!definition && inputs.length >= 2 && JSON.stringify(lastComparisonAttempt(record)?.basis) !== JSON.stringify(basis)) {
        const timeout = Math.min(120, record.request.actionTimeoutSeconds);
        definition = { tool: "compare_research_materials", source_id: null, basis, timeout_seconds: timeout, arguments: { question: record.request.question, ...(record.request.language ? { language: record.request.language } : {}), timeout_seconds: timeout } };
      }
      if (!definition) break;
      if (record.budget.attempted_actions >= record.budget.max_actions || record.budget.reserved_timeout_seconds + definition.timeout_seconds > record.budget.total_timeout_seconds) { stoppedForBudget = true; break; }
      // Only the built-in dispatcher owns these local sessions and provider settings.
      // A known local refusal occurs before dispatch; arbitrary host exceptions still have unknown outcomes.
      if (!options.host && definition.tool === "resume_long_video_research") {
        const refusal = await localSessionRefusal(definition);
        if (refusal) {
          if (record.status !== "needs_attention" || record.stop_reason !== refusal) { record.status = "needs_attention"; record.stop_reason = refusal; await checkpoint(); }
          return view(record);
        }
      }
      const safe = sanitizeResearchSnapshot(definition);
      const action: LinkResearchAction = { ...safe, index: record.actions.length, key: linkActionKey(safe), state: "running", started_at: now(), finished_at: null, result: null, error: null };
      record.actions.push(action); record.budget.attempted_actions++; record.budget.reserved_timeout_seconds += action.timeout_seconds;
      record.status = "running"; record.stop_reason = "executing_saved_task"; await checkpoint();
      if (definition.source_id) attemptedSources.add(definition.source_id);
      const args = structuredClone(definition.arguments);
      if (definition.source_id && fresh.has(definition.source_id)) args.url = fresh.get(definition.source_id);
      if (definition.tool === "compare_research_materials") args.materials = inputs;
      let result: Record<string, unknown>;
      try { result = await validateLinkReceipt(record.actions[action.index], sanitizeResearchSnapshot(await dispatch(host, definition, args, options.signal)), record, definition.tool === "compare_research_materials" ? inputs : undefined); }
      catch {
        const savedAction = record.actions[action.index];
        savedAction.state = "unknown"; savedAction.finished_at = now(); savedAction.error = { code: "OUTCOME_UNKNOWN", message: "No valid structured result was confirmed. The operation may have incurred cost or saved a video session; inspect it before taking further action." };
        record.status = "needs_attention"; record.stop_reason = "outcome_unknown"; await checkpoint(); return view(record);
      }
      const savedAction = record.actions[action.index];
      savedAction.state = "recorded"; savedAction.finished_at = now(); savedAction.result = result; await checkpoint();
    }
    const progress = record.sources.map(s => sourceProgress(record, s)), comparison = currentComparison(record);
    const needsComparison = materials(record).length >= 2;
    const finished = progress.every(p => p.status === "complete") && (!needsComparison || comparison.comparison_current);
    const blocked = progress.some(p => p.status !== "complete" && !p.can_continue) || needsComparison && !comparison.comparison_current && lastComparisonAttempt(record)?.result?.status === "unavailable";
    const status = stoppedForBudget ? "budget_exhausted" : finished ? "completed" : blocked ? "needs_attention" : "partial";
    const reason = stoppedForBudget ? "cumulative_budget_exhausted" : finished ? "planned_coverage_recorded" : blocked ? "source_or_comparison_needs_attention" : "more_work_available";
    if (record.status !== status || record.stop_reason !== reason) { record.status = status; record.stop_reason = reason; await checkpoint(); }
    return view(record);
  });
}
