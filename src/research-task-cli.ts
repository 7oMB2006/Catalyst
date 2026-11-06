#!/usr/bin/env node
import "dotenv/config";
import { constants, promises as fs } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CreateResearchTaskRequest, ResearchTaskHost } from "./research-task-contracts.js";
import { AnyResearchTaskStore } from "./link-research-store.js";
import { continueLinkResearchRequestSchema, linkResearchRequestSchema } from "./link-research-schema.js";
import type { LinkResearchRequest } from "./link-research-contracts.js";
import { createResearchTask, runResearchTask } from "./research-tasks.js";
import { redactSensitiveText } from "./video-analysis.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const commands = [
  "start <input.json> (links and question)", "continue <task-id> [input.json]",
  "create <input.json>", "show <task-id>", "list", "delete <task-id>",
  "run <task-id> <action-key>... (resume the same selection by omitting keys)",
];
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

/** Never print or persist a raw MCP error response; structured partial results are still useful. */
export function createMcpResearchTaskHost(client: Pick<Client, "callTool">): ResearchTaskHost {
  return {
    async callTool(name, args, signal) {
      const requested = name === "plan_research_followup" ? args.planning_timeout_seconds ?? 10
        : name === "start_research_task" ? args.total_timeout_seconds ?? 1800
        : name === "continue_research_task" ? 3600 : args.timeout_seconds ?? 240;
      const seconds = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : 240;
      const cleanup = name === "start_research_task" ? 30_000 : 0;
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: seconds * 1000 + cleanup + 15_000, signal }).catch(() => {
        if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was cancelled.", "AbortError");
        return fail("TASK_TOOL_CALL_FAILED", "The MCP tool call failed before a structured response was confirmed. Inspect the task before attempting more work.");
      });
      if (!response.structuredContent || typeof response.structuredContent !== "object" || Array.isArray(response.structuredContent)) {
        fail("TASK_TOOL_RESPONSE_INVALID", "The MCP tool did not return structured research content. Inspect the task before attempting more work.");
      }
      return response.structuredContent;
    },
  };
}

async function readInput(path: string): Promise<Record<string, unknown>> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let content = "";
  try {
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) fail("TASK_INPUT_INVALID", "The input must be a regular local JSON file.");
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) fail("TASK_INPUT_INVALID", "The input changed while opening.");
    if (opened.size > MAX_INPUT_BYTES) fail("TASK_INPUT_TOO_LARGE", "The task input exceeds 2 MiB.");
    const chunks: Buffer[] = []; let bytes = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); bytes += bytesRead;
      if (bytes > MAX_INPUT_BYTES) fail("TASK_INPUT_TOO_LARGE", "The task input exceeds 2 MiB.");
    }
    content = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "string" && (error as { code: string }).code.startsWith("TASK_")) throw error;
    fail("TASK_INPUT_UNREADABLE", "The task input file could not be read.");
  } finally { await handle?.close(); }
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { fail("TASK_INPUT_INVALID", "The task input must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("TASK_INPUT_INVALID", "Supply a task request JSON object.");
  return value as Record<string, unknown>;
}

export function linkRequestToToolArguments(input: LinkResearchRequest): Record<string, unknown> {
  return {
    urls: input.urls, question: input.question, mode: input.mode, language: input.language,
    total_timeout_seconds: input.totalTimeoutSeconds, action_timeout_seconds: input.actionTimeoutSeconds,
    max_actions: input.maxActions, segment_seconds: input.segmentSeconds, max_segments: input.maxSegments,
    max_detail_windows: input.maxDetailWindows,
  };
}

async function withHost<T>(operation: (host: ResearchTaskHost, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("The host stopped this operation.", "AbortError"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./index.js", import.meta.url))],
    stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  // Drain diagnostics without echoing potentially sensitive tool/provider output.
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "catalyst-research-task-host", version: "1.0" });
  try {
    await client.connect(transport, { signal: controller.signal, timeout: 15_000 });
    return await operation(createMcpResearchTaskHost(client), controller.signal);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}

/** Link workflows use MCP task tools; explicit selected-round commands retain v1 behavior. */
export async function researchTaskCli(args: string[]): Promise<unknown> {
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0])) return { commands };
  const [command, id, ...keys] = args;
  if (command === "start" && args.length === 2) {
    const parsed = linkResearchRequestSchema.safeParse(await readInput(id));
    const input = parsed.success ? parsed.data : fail("TASK_INPUT_INVALID", "Supply one to three supported source links, a question, and valid optional task budgets.");
    return withHost((host, signal) => host.callTool("start_research_task", linkRequestToToolArguments(input), signal));
  }
  if (command === "continue" && (args.length === 2 || args.length === 3)) {
    const parsed = continueLinkResearchRequestSchema.safeParse(args.length === 3 ? await readInput(keys[0]) : {});
    const input = parsed.success ? parsed.data : fail("TASK_INPUT_INVALID", "Continuation input accepts maxSteps and optional fresh sourceUrls only; task budgets and question remain fixed.");
    // Validate the ID and record locally before starting a subprocess.
    const task = await new AnyResearchTaskStore().load(id);
    if (task.schema_version !== "2") fail("TASK_INPUT_INVALID", "Use run for a selected-round task; continue accepts a link research task.");
    return withHost((host, signal) => host.callTool("continue_research_task", {
      task_id: id, max_steps: input.maxSteps,
      source_urls: input.sourceUrls?.map(({ sourceId, url }) => ({ source_id: sourceId, url })),
    }, signal));
  }
  if (command === "create" && args.length === 2) {
    const input = await readInput(id);
    if (!input.plan || typeof input.plan !== "object" || Array.isArray(input.plan)) fail("TASK_INPUT_INVALID", "Supply an object containing plan with the planner request and optional totalTimeoutSeconds.");
    return withHost((host, signal) => createResearchTask(input as unknown as CreateResearchTaskRequest, { host, signal }));
  }
  if (command === "run" && args.length >= 2) return withHost((host, signal) => runResearchTask(id, keys.length ? keys : undefined, { host, signal }));
  const store = new AnyResearchTaskStore();
  if (command === "show" && args.length === 2) return store.load(id);
  if (command === "delete" && args.length === 2) { await store.delete(id); return { id, deleted: true }; }
  if (command === "list" && args.length === 1) return {
    tasks: (await store.list()).map((record) => ({ id: record.id, revision: record.revision, status: record.status, question: record.request.question, stop_reason: record.stop_reason, budget: record.budget, updated_at: record.updated_at })),
  };
  return fail("TASK_CLI_USAGE", `Use one of: ${commands.join("; ")}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await researchTaskCli(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    process.stderr.write(`${JSON.stringify({ error: {
      code: redactSensitiveText(typeof value.code === "string" ? value.code : "TASK_CLI_FAILED"),
      message: redactSensitiveText(typeof value.message === "string" ? value.message : "The research task operation failed."),
    } })}\n`);
    process.exitCode = 1;
  }
}
