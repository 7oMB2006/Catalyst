import type { FollowupAction, FollowupPlanRequest } from "./followup-plan-contracts.js";
import type { CreateResearchTaskRequest, ResearchTaskOptions, ResearchTaskRecord } from "./research-task-contracts.js";
import { createResearchTaskRequestSchema, parseActionResult, parseResearchTaskRecord } from "./research-task-schema.js";
import { followupPlanResultSchema } from "./followup-plan-schema.js";
import { ResearchTaskStore } from "./research-task-store.js";
import { sanitizeResearchSnapshot } from "./research-sessions.js";
import { preparePlanningMaterials } from "./followup-plan-materials.js";
import type { ComparisonInput } from "./comparison-contracts.js";
import { canonicalResearchSourceUrl } from "./comparison-materials.js";
import { normalizeDiscoveryQueries } from "./discovery.js";

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
const now = () => new Date().toISOString();
export function planToToolArguments(r: FollowupPlanRequest): Record<string, unknown> {
  return { question: r.question, materials: r.materials, evidence_requirement: r.evidenceRequirement, coverage_target: r.coverageTarget, search_queries: r.searchQueries, discovery: r.discovery, max_actions: r.maxActions, max_sources: r.maxSources, max_rounds: r.maxRounds, round: r.round, attempted_action_keys: r.attemptedActionKeys, video_window_seconds: r.videoWindowSeconds, note_pages_per_action: r.notePagesPerAction, action_timeout_seconds: r.actionTimeoutSeconds, planning_timeout_seconds: r.planningTimeoutSeconds };
}
async function invoke(options: ResearchTaskOptions, name: string, args: Record<string, unknown>, seconds: number): Promise<unknown> {
  options.signal?.throwIfAborted();
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException("Research action deadline exceeded.", "TimeoutError")), seconds * 1000);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { listener = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); signal.addEventListener("abort", listener, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return options.host.callTool(name, args, signal); }), aborted]); }
  finally { clearTimeout(timer); if (listener) signal.removeEventListener("abort", listener); }
}

/** One immutable plan per task. The host, rather than a model inside this runner, selects actions. */
export async function createResearchTask(request: CreateResearchTaskRequest, options: ResearchTaskOptions): Promise<ResearchTaskRecord> {
  if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) fail("TASK_TOO_LARGE", "Task input exceeds 2 MiB.");
  const input = createResearchTaskRequestSchema.parse(sanitizeResearchSnapshot(request));
  options.signal?.throwIfAborted();
  const plan = followupPlanResultSchema.parse(await invoke(options, "plan_research_followup", planToToolArguments(input.plan as FollowupPlanRequest), input.plan.planningTimeoutSeconds));
  if (plan.status === "unavailable") fail("TASK_PLAN_FAILED", "The planner could not prepare a task. Inspect the materials and planning request.");
  const store = options.store ?? new ResearchTaskStore(), timestamp = now();
  const record = parseResearchTaskRecord({ schema_version: "1", id: store.newId(), revision: 1, created_at: timestamp, updated_at: timestamp, request: input.plan, plan, selected_keys: null, actions: plan.next_actions.map(action => ({ key: action.key, state: "pending", started_at: null, finished_at: null, result: null, error: null })), status: "planned", budget: { max_actions: input.plan.maxActions, attempted_actions: 0, total_timeout_seconds: input.totalTimeoutSeconds, reserved_timeout_seconds: 0 }, stop_reason: plan.stop_reason });
  await store.withLock(record.id, () => store.save(record, null));
  return sanitizeResearchSnapshot(record);
}

async function validateOutcome(action: FollowupAction, value: unknown, record: ResearchTaskRecord): Promise<Record<string, unknown>> {
  const result = parseActionResult(action, value);
  if (action.tool === "discover_bilibili_videos") {
    if (result.question !== record.plan.question || JSON.stringify((result.queries as Array<{query:string}>).map(q => q.query)) !== JSON.stringify(normalizeDiscoveryQueries(action.arguments.queries as string[]))) fail("TASK_RESULT_MISMATCH", "The discovery result does not match the selected question and queries.");
    return result;
  }
  const leaf = action.tool === "analyze_xiaohongshu_note" ? result.result as Record<string, unknown> | null : result;
  if (!leaf) { if (result.status === "complete") fail("TASK_RESULT_MISMATCH", "A complete result must have a resolved research source."); return result; }
  const request = leaf.request as Record<string, unknown>;
  if (typeof request.question !== "string" || request.question.trim() !== record.plan.question) fail("TASK_RESULT_MISMATCH", "The result answers a different question.");
  const resolved = leaf.video ?? leaf.note;
  if (action.arguments.url) {
    const identity = resolved as { platform: string; id: string } | null;
    const requestUrl = identity && typeof request.url === "string" ? canonicalResearchSourceUrl(request.url, identity.platform, identity.id) : request.url;
    if (requestUrl !== action.arguments.url) fail("TASK_RESULT_MISMATCH", "The result request names a different source URL.");
  }
  if (action.tool === "analyze_video_url" && (request.mode !== action.arguments.mode || request.startSeconds !== action.arguments.start_seconds || request.endSeconds !== action.arguments.end_seconds)) fail("TASK_RESULT_MISMATCH", "The result does not match the selected video window or mode.");
  if (action.tool === "analyze_xiaohongshu_note" && (request.mode !== action.arguments.mode || request.startPage !== action.arguments.start_page || request.endPage !== action.arguments.end_page)) fail("TASK_RESULT_MISMATCH", "The result does not match the selected note pages or mode.");
  if (action.tool === "resume_long_video_research" && (result.session as { id?: string } | undefined)?.id !== action.arguments.session_id) fail("TASK_RESULT_MISMATCH", "The result names a different saved session.");
  if (!resolved) { if (result.status === "complete" || leaf.status === "complete" || (leaf.evidence as unknown[]).length) fail("TASK_RESULT_MISMATCH", "A complete or evidence-bearing result must have a resolved source."); return result; }
  // Normalize source metadata without imposing the comparison tool's 80-item evidence budget.
  const metadata = { ...leaf, evidence: [], findings: [], plan: undefined };
  const material: ComparisonInput = action.tool === "analyze_xiaohongshu_note" && "note" in leaf ? { kind: "note", result: metadata as never } : { kind: "video", result: metadata as never };
  const [prepared] = await preparePlanningMaterials([material], record.plan.question, { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
  const expected = record.plan.materials.find(m => m.source_key === action.source_key);
  if (!prepared.eligible || !expected || prepared.url !== expected.url) fail("TASK_RESULT_MISMATCH", "The result does not match the selected source or evidence contract.");
  let permitsResolvedPart = false;
  for (const input of record.request.materials) {
    if (input.kind === "session") continue;
    const raw = input.kind === "xiaohongshu" ? input.result.result : input.result;
    if (!raw || !("video" in raw) || !raw.video) continue;
    const [original] = await preparePlanningMaterials([input], record.plan.question, { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
    if (original.eligible && original.source_key === expected.source_key && !raw.video.partId) permitsResolvedPart = true;
  }
  if (prepared.source_key !== expected.source_key && !permitsResolvedPart) fail("TASK_RESULT_MISMATCH", "The result changed the selected source's known identity.");
  const source = resolved as { platform: string; id: string; partId?: string; durationSeconds?: number; imageCount?: number };
  const ids = new Set<string>();
  const normalizedId = (id: string) => source.platform === "xiaohongshu" ? id.toLowerCase() : source.platform === "bilibili" ? id.replace(/^bv/i, "BV") : id;
  for (const item of leaf.evidence as Array<{id:string;kind:string;source:{platform:string;video_id?:string;note_id?:string;part_id?:string;url:string};time_basis?:string;time_range?:{start_seconds:number;end_seconds:number}|null;page?:number|null}>) {
    if (ids.has(item.id)) fail("TASK_RESULT_MISMATCH", "The result has duplicate evidence identities.");
    ids.add(item.id);
    if (item.source.platform !== source.platform || normalizedId(item.source.video_id ?? item.source.note_id ?? "") !== normalizedId(source.id) || item.source.part_id !== source.partId || canonicalResearchSourceUrl(item.source.url, source.platform, source.id) !== prepared.url) fail("TASK_RESULT_MISMATCH", "A result evidence item belongs to a different source or part.");
    if ("note" in leaf) {
      if (item.kind === "note_text" ? item.page !== null || request.startPage !== undefined : item.page === null || item.page === undefined || item.page < Number(request.startPage ?? 1) || item.page > Number(request.endPage ?? source.imageCount)) fail("TASK_RESULT_MISMATCH", "A result evidence item has a foreign image page.");
    } else if (!["metadata", "community"].includes(item.kind)) {
      const range = item.time_range, start = Number(request.startSeconds ?? 0), end = Number(request.endSeconds ?? source.durationSeconds);
      if (item.time_basis !== "source" || !range || range.end_seconds <= range.start_seconds || range.start_seconds < 0 || range.end_seconds > Number(source.durationSeconds) || (item.kind === "caption" ? range.end_seconds <= start || range.start_seconds >= end : range.start_seconds < start || range.end_seconds > end)) fail("TASK_RESULT_MISMATCH", "A result evidence item has a foreign time interval.");
    }
  }
  for (const finding of leaf.findings as Array<{evidence_ids:string[]}>) if (!finding.evidence_ids.length || new Set(finding.evidence_ids).size !== finding.evidence_ids.length || finding.evidence_ids.some(id => !ids.has(id))) fail("TASK_RESULT_MISMATCH", "A result finding has foreign or missing evidence references.");
  return result;
}

/** Persist intent before dispatch. Missing acknowledgements are unknown, never automatically retried. */
export async function runResearchTask(id: string, selectedKeys: string[] | undefined, options: ResearchTaskOptions): Promise<ResearchTaskRecord> {
  const store = options.store ?? new ResearchTaskStore();
  return store.withLock(id, async () => {
    let record = parseResearchTaskRecord(await store.load(id), id);
    const checkpoint = async () => {
      const previous = record.revision;
      const next = sanitizeResearchSnapshot({ ...record, revision: previous + 1, updated_at: now() });
      parseResearchTaskRecord(next, id); await store.save(next, previous); record = next;
    };
    if (selectedKeys !== undefined && (!selectedKeys.length || new Set(selectedKeys).size !== selectedKeys.length || selectedKeys.some(key => !record.actions.some(a => a.key === key)))) fail("TASK_INVALID_SELECTION", "Select unique action keys from this task's saved plan.");
    if (record.selected_keys && selectedKeys && JSON.stringify([...record.selected_keys].sort()) !== JSON.stringify([...selectedKeys].sort())) fail("TASK_SELECTION_FROZEN", "A task's selected actions cannot change after execution begins.");
    if (!record.selected_keys) {
      if (!selectedKeys?.length) fail("TASK_SELECTION_REQUIRED", "Explicitly select action keys before the first execution.");
      options.signal?.throwIfAborted(); record.selected_keys = [...selectedKeys]; await checkpoint();
    }
    if (record.actions.some(a => a.state === "running")) {
      for (const a of record.actions.filter(a => a.state === "running")) { a.state = "unknown"; a.finished_at = now(); a.error = { code: "OUTCOME_UNKNOWN", message: "Execution was interrupted after durable dispatch intent. Inspect the original tool/session; no automatic replay is permitted." }; }
      record.status = "needs_attention"; record.stop_reason = "outcome_unknown"; await checkpoint(); return record;
    }
    if (record.actions.some(a => a.state === "unknown")) return record;
    for (let index = 0; index < record.actions.length; index++) {
      let action = record.actions[index];
      if (!record.selected_keys!.includes(action.key) || action.state === "recorded") continue;
      if (options.signal?.aborted) { record.status = "cancelled"; record.stop_reason = "cancelled_before_dispatch"; await checkpoint(); return record; }
      const definition = record.plan.next_actions[index], timeout = Number(definition.arguments.timeout_seconds);
      if (record.budget.attempted_actions >= record.budget.max_actions || record.budget.reserved_timeout_seconds + timeout > record.budget.total_timeout_seconds) { record.status = "budget_exhausted"; record.stop_reason = "execution_budget_exhausted"; await checkpoint(); return record; }
      action.state = "running"; action.started_at = now();
      record.budget.attempted_actions++; record.budget.reserved_timeout_seconds += timeout;
      record.status = "running"; record.stop_reason = "executing_selected_action"; await checkpoint();
      action = record.actions[index];
      let result: Record<string, unknown>;
      try { result = await validateOutcome(definition, await invoke(options, definition.tool, structuredClone(definition.arguments), timeout), record); }
      catch {
        action.state = "unknown"; action.finished_at = now(); action.error = { code: "OUTCOME_UNKNOWN", message: "The tool response was not confirmed, was invalid, or execution was cancelled. Its outcome may have side effects or cost; inspect it before taking further action." };
        record.status = "needs_attention"; record.stop_reason = "outcome_unknown"; await checkpoint(); return record;
      }
      action.state = "recorded"; action.finished_at = now(); action.result = sanitizeResearchSnapshot(result); await checkpoint();
    }
    const selected = record.actions.filter(a => record.selected_keys!.includes(a.key));
    const status = selected.every(a => a.result?.status === "complete") ? "completed" : "partial";
    if (record.status !== status || record.stop_reason !== "selected_actions_recorded") { record.status = status; record.stop_reason = "selected_actions_recorded"; await checkpoint(); }
    return record;
  });
}
