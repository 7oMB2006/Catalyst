import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LinkResearchTaskView } from "./link-research-contracts.js";
import { startLinkResearchTask, continueLinkResearchTask, getLinkResearchTask } from "./link-research.js";
import { LinkResearchTaskStore } from "./link-research-store.js";
import { linkResearchTaskViewShape } from "./link-research-schema.js";

export interface LinkResearchToolDependencies {
  start?: typeof startLinkResearchTask;
  continue?: typeof continueLinkResearchTask;
  get?: typeof getLinkResearchTask;
  store?: Pick<LinkResearchTaskStore, "list" | "load" | "delete">;
}

const taskId = z.string().uuid().describe("Local task UUID returned by start_research_task or list_research_tasks.");
function reply(value: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value, isError };
}
function taskReply(view: LinkResearchTaskView) { return reply({ ...view }, view.task.status === "needs_attention"); }
function failure(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  // Unknown provider/transport exceptions can contain access URLs or private paths.
  const issue = { code: typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "TASK_FAILED", message: "The research task operation could not be completed. Check the supplied arguments and the saved task before continuing." };
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: issue }) }], isError: true };
}

/** Bounded workflows over the existing research engines, invoked only by the host. */
export function registerLinkResearchTools(server: McpServer, dependencies: LinkResearchToolDependencies = {}): void {
  server.registerTool("start_research_task", {
    title: "Start Research from Links",
    description: "Start one persistent research task from one to three selected Bilibili, YouTube or Xiaohongshu links and a question. Reads the supplied sources with bounded calls, saves source evidence and progress, and compares retained materials when possible. A single link works without comparison. Long videos use saved segmented research; image notes retain page citations. Returns a task_id in task.id for explicit continuation. The initial call runs at most three steps; budget reservations include comparison calls and persist across continuations. Source access, configured provider, or budget limits can leave partial work. No background continuation or independent source discovery. Use continue_research_task for the same question and get_research_task for saved progress.",
    inputSchema: z.strictObject({
      urls: z.array(z.string().min(1).max(8192)).min(1).max(3).describe("One to three explicitly selected source links or Xiaohongshu share texts. Keep original access parameters; they are used in memory and removed from saved snapshots."),
      question: z.string().trim().min(3).max(2000),
      mode: z.enum(["language", "vision", "multimodal"]).default("language").describe("language reads captions/ASR or note text/OCR; vision reads pixels; multimodal uses both channels."),
      language: z.string().min(2).max(20).optional(),
      total_timeout_seconds: z.number().int().min(15).max(3600).default(1800).describe("Cumulative declared timeout allowance for this task. Each dispatched step reserves its full timeout, without refunds; continuation never resets this allowance."),
      action_timeout_seconds: z.number().int().min(15).max(600).default(240).describe("Timeout reserved for each source-reading step. Comparison reserves at most 120 seconds."),
      max_actions: z.number().int().min(1).max(16).default(12).describe("Cumulative dispatched-step limit, including comparisons."),
      segment_seconds: z.number().int().min(120).max(900).default(600),
      max_segments: z.number().int().min(1).max(24).default(12).describe("Preflight overview limit per selected video; an oversized source is reported rather than silently truncated."),
      max_detail_windows: z.number().int().min(0).max(4).optional().describe("Defaults to zero for language and two otherwise."),
    }),
    outputSchema: linkResearchTaskViewShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ urls, question, mode, language, total_timeout_seconds, action_timeout_seconds, max_actions, segment_seconds, max_segments, max_detail_windows }, extra) => {
    try {
      return taskReply(await (dependencies.start ?? startLinkResearchTask)({
        urls, question, mode, language, totalTimeoutSeconds: total_timeout_seconds,
        actionTimeoutSeconds: action_timeout_seconds, maxActions: max_actions,
        segmentSeconds: segment_seconds, maxSegments: max_segments, maxDetailWindows: max_detail_windows,
      }, { signal: extra.signal }));
    } catch (error) { return failure(error); }
  });
  server.registerTool("continue_research_task", {
    title: "Continue a Saved Research Task",
    description: "Continue the same saved links and question from durable progress. Reads pending sources or unfinished video windows/image pages, retaining completed evidence and cumulative budget. Refreshes comparison when retained evidence changes. A completed task performs no more source/model calls. A missing acknowledgement remains needs_attention and is never automatically replayed. The host maps a user's request to continue to the saved task UUID; the user need not supply result JSON or reading offsets. No background execution.",
    inputSchema: z.strictObject({
      task_id: taskId,
      max_steps: z.number().int().min(1).max(4).default(3).describe("Maximum source-reading/comparison steps in this invocation, within the task's remaining cumulative limits."),
      source_urls: z.array(z.strictObject({
        source_id: z.string().regex(/^source:[1-3]$/),
        url: z.string().min(1).max(8192),
      })).max(3).optional().describe("Optional fresh original access URLs for named saved sources. They must resolve to the same source and are not persisted with access parameters."),
    }),
    outputSchema: linkResearchTaskViewShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ task_id, max_steps, source_urls }, extra) => {
    try {
      return taskReply(await (dependencies.continue ?? continueLinkResearchTask)(task_id, {
        maxSteps: max_steps, sourceUrls: source_urls?.map(({ source_id, url }) => ({ sourceId: source_id, url })),
      }, { signal: extra.signal }));
    } catch (error) { return failure(error); }
  });
  server.registerTool("get_research_task", {
    title: "Read Saved Research Progress",
    description: "Read one local link research task, retained evidence, progress, cumulative budget and comparison freshness without source or provider calls. Does not continue work.",
    inputSchema: z.strictObject({ task_id: taskId }), outputSchema: linkResearchTaskViewShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ task_id }) => {
    try { return taskReply(await (dependencies.get ?? getLinkResearchTask)(task_id)); }
    catch (error) { return failure(error); }
  });
  server.registerTool("list_research_tasks", {
    title: "List Saved Link Research Tasks",
    description: "List up to 100 local link research tasks, their questions, status and cumulative budget, newest first. Use the task UUID to read or continue the intended task. No source or provider calls.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      const tasks = (await (dependencies.store ?? new LinkResearchTaskStore()).list()).map((task) => ({
        id: task.id, revision: task.revision, question: task.request.question,
        urls: task.sources.map((source) => source.url), status: task.status,
        stop_reason: task.stop_reason, budget: task.budget, updated_at: task.updated_at,
      }));
      return reply({ tasks });
    } catch (error) { return failure(error); }
  });
  server.registerTool("delete_research_task", {
    title: "Delete a Saved Link Research Task",
    description: "Delete one local link research task record. Refuses while it is running. Related long-video sessions remain available through the session tools. No remote source is changed.",
    inputSchema: z.strictObject({ task_id: taskId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => {
    try {
      const store = dependencies.store ?? new LinkResearchTaskStore();
      // The legacy selected-round records share the directory but this tool owns link tasks.
      await store.load(task_id);
      await store.delete(task_id);
      return reply({ task_id, deleted: true });
    } catch (error) { return failure(error); }
  });
}
