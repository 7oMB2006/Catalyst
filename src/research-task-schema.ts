import { createHash } from "node:crypto";
import { z } from "zod";
import { followupPlanRequestSchema, followupPlanResultSchema } from "./followup-plan-schema.js";
import { researchResultSchema } from "./result-schema.js";
import { xiaohongshuResearchResultSchema } from "./note-result-schema.js";
import { longVideoResultSchema } from "./long-video-schema.js";
import { discoveryResultSchema } from "./discovery-schema.js";
import type { FollowupAction } from "./followup-plan-contracts.js";
import type { ResearchTaskRecord } from "./research-task-contracts.js";

const key = z.string().regex(/^[a-f0-9]{64}$/);
export const createResearchTaskRequestSchema = z.strictObject({
  plan: followupPlanRequestSchema.refine(r => r.materials.length >= 2, "Select two or three existing materials."),
  totalTimeoutSeconds: z.number().int().min(15).max(1800).default(900),
});
export const researchTaskRecordSchema = z.strictObject({
  schema_version: z.literal("1"), id: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(), request: followupPlanRequestSchema,
  plan: followupPlanResultSchema, selected_keys: z.array(key).min(1).max(5).nullable(),
  actions: z.array(z.strictObject({ key, state: z.enum(["pending", "running", "recorded", "unknown"]), started_at: z.iso.datetime().nullable(), finished_at: z.iso.datetime().nullable(), result: z.record(z.string(), z.unknown()).nullable(), error: z.object({ code: z.string(), message: z.string() }).nullable() })).max(5),
  status: z.enum(["planned", "running", "completed", "partial", "needs_attention", "budget_exhausted", "cancelled"]),
  budget: z.strictObject({ max_actions: z.number().int().min(1).max(5), attempted_actions: z.number().int().min(0).max(5), total_timeout_seconds: z.number().int().min(15).max(1800), reserved_timeout_seconds: z.number().int().min(0).max(1800) }),
  stop_reason: z.string().max(100),
});
export function actionKey(question: string, action: FollowupAction): string {
  const { timeout_seconds: _timeout, window_timeout_seconds: _window, max_download_mb: _bytes, ...semantic } = action.arguments;
  return createHash("sha256").update(JSON.stringify({ question, tool: action.tool, source: action.source_key, arguments: semantic })).digest("hex");
}
export function parseActionResult(action: FollowupAction, input: unknown): Record<string, unknown> {
  const schema = action.tool === "analyze_video_url" ? researchResultSchema : action.tool === "analyze_xiaohongshu_note" ? xiaohongshuResearchResultSchema : action.tool === "resume_long_video_research" ? longVideoResultSchema : discoveryResultSchema;
  return schema.parse(input) as Record<string, unknown>;
}
export function parseResearchTaskRecord(input: unknown, id?: string): ResearchTaskRecord {
  const r = researchTaskRecordSchema.parse(input) as unknown as ResearchTaskRecord;
  const bad = () => { throw Object.assign(new Error("The research task has inconsistent plan, action or budget records."), { code: "TASK_CORRUPT" }); };
  if ((id !== undefined && r.id !== id) || r.request.materials.length < 2 || r.plan.question !== r.request.question || r.actions.length !== r.plan.next_actions.length || r.budget.max_actions !== (r.request.maxActions ?? 3) || r.plan.budget.max_actions !== r.budget.max_actions || r.actions.length > r.budget.max_actions) bad();
  const keys = new Set<string>();
  let attempted = 0, reserved = 0;
  for (const [i, definition] of r.plan.next_actions.entries()) {
    const a = r.actions[i];
    if (keys.has(a.key) || a.key !== definition.key || a.key !== actionKey(r.plan.question, definition)) bad();
    keys.add(a.key);
    const timeout = definition.arguments.timeout_seconds;
    if (!Number.isInteger(timeout) || Number(timeout) < 15 || Number(timeout) > 600) bad();
    if (a.state === "pending") { if (a.result || a.started_at || a.finished_at || a.error) bad(); }
    else {
      attempted++; reserved += Number(timeout);
      if (!a.started_at || !r.selected_keys?.includes(a.key)) bad();
      if (a.state === "recorded") { if (!a.result || !a.finished_at || a.error) bad(); parseActionResult(definition, a.result); }
      else if (a.result || (a.state === "running" && (a.finished_at || a.error)) || (a.state === "unknown" && !a.error)) bad();
    }
  }
  if (r.selected_keys && (new Set(r.selected_keys).size !== r.selected_keys.length || r.selected_keys.some(k => !keys.has(k)))) bad();
  if (attempted !== r.budget.attempted_actions || reserved !== r.budget.reserved_timeout_seconds || reserved > r.budget.total_timeout_seconds || attempted > r.budget.max_actions) bad();
  return r;
}
