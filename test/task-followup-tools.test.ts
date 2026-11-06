import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ComparisonResult } from "../src/comparison-contracts.js";
import type { LinkResearchAction, LinkResearchTaskRecord, LinkResearchTaskView } from "../src/link-research-contracts.js";
import { followUpLinkResearchRequestSchema, linkActionKey, linkResearchRequestSchema, parseLinkResearchTaskRecord } from "../src/link-research-schema.js";
import { LinkResearchTaskStore } from "../src/link-research-store.js";
import { registerLinkResearchTools, type LinkResearchToolDependencies } from "../src/link-research-tools.js";
import { createMcpResearchTaskHost, followUpRequestToToolArguments } from "../src/research-task-cli.js";
import { startLinkResearchTask } from "../src/link-research.js";
import { engineHost, NOTE_URL, QUESTION, VIDEO_ONE } from "./helpers/link-research-fixtures.js";

const CHILD_QUESTION = "Using these sources, what are the minimum implementation steps and their evidence?";
const NOW = "2026-11-06T04:00:00.000Z";
function childRecord(): LinkResearchTaskRecord {
  return {
    schema_version: "2", kind: "link_research", id: randomUUID(), revision: 1, created_at: NOW, updated_at: NOW,
    request: linkResearchRequestSchema.parse({ urls: [VIDEO_ONE], question: CHILD_QUESTION }),
    sources: [{ id: "source:1", url: VIDEO_ONE, kind: "video" }], actions: [], status: "ready",
    budget: { max_actions: 12, attempted_actions: 0, total_timeout_seconds: 1800, reserved_timeout_seconds: 0 }, stop_reason: "follow_up_saved",
    follow_up: { parent_task_id: randomUUID(), parent_revision: 7, snapshots: [{ source_id: "source:1", material: null }] },
  };
}
function childView(): LinkResearchTaskView {
  return { task: parseLinkResearchTaskRecord(childRecord()), progress: [{ source_id: "source:1", status: "unavailable", can_continue: false, reason: "retained_text_unavailable" }], materials: [], comparison: null, comparison_current: false, answer: null, answer_current: false, limitations: [] };
}
async function memoryClient(dependencies: LinkResearchToolDependencies) {
  const server = new McpServer({ name: "task-follow-up-test", version: "1.0" });
  registerLinkResearchTools(server, dependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "task-follow-up-client", version: "1.0" });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("follow-up request keeps omitted inherited settings absent and refuses replacing the parent source set", () => {
  assert.deepEqual(followUpLinkResearchRequestSchema.parse({ question: `  ${CHILD_QUESTION}  ` }), { question: CHILD_QUESTION, mode: "language" });
  for (const request of [
    { question: CHILD_QUESTION, urls: [VIDEO_ONE] }, { question: CHILD_QUESTION, materials: [] },
    { question: CHILD_QUESTION, maxDetailWindows: 1 }, { question: CHILD_QUESTION, totalTimeoutSeconds: 3601 },
    { question: CHILD_QUESTION, sourceUrls: [{ sourceId: "source:1", url: VIDEO_ONE }, { sourceId: "source:1", url: VIDEO_ONE }] },
  ]) assert.equal(followUpLinkResearchRequestSchema.safeParse(request).success, false);
  assert.equal(followUpLinkResearchRequestSchema.parse({ question: CHILD_QUESTION, mode: "multimodal", maxDetailWindows: 1 }).maxDetailWindows, 1);
});

test("saved child answers permit seed-only input but cannot masquerade as parent reads or ordinary comparisons", () => {
  const record = childRecord();
  const result: ComparisonResult = { schema_version: "1.0", status: "unavailable", question: CHILD_QUESTION, materials: [], evidence: [], comparisons: [], analysis: null, source_independence: "not_established", warnings: [], errors: [{ code: "MATERIAL_UNAVAILABLE", message: "The parent has no retained text." }], processing: { duration_ms: 0, provider: null, model_calls: 0 } };
  const definition = { tool: "answer_research_materials" as const, source_id: null, basis: [], arguments: { question: CHILD_QUESTION, timeout_seconds: 120, materials_hash: "a".repeat(64) } };
  const action: LinkResearchAction = { ...definition, index: 0, key: linkActionKey(definition), timeout_seconds: 120, state: "recorded", started_at: NOW, finished_at: NOW, result: result as unknown as Record<string, unknown>, error: null };
  record.actions = [action]; record.budget.attempted_actions = 1; record.budget.reserved_timeout_seconds = 120;
  record.status = "needs_attention";
  assert.deepEqual(parseLinkResearchTaskRecord(record), record);
  const mutations: Array<(r: LinkResearchTaskRecord) => void> = [
    r => { delete r.follow_up; }, r => { r.follow_up!.parent_task_id = r.id; },
    r => { r.follow_up!.snapshots[0].source_id = "source:2"; },
    r => { r.follow_up!.snapshots[0].material = { kind: "session", session_id: randomUUID() } as never; },
    r => { r.actions[0].source_id = "source:1"; },
    r => { r.actions[0].basis = [0]; },
    r => { r.actions[0].arguments.materials_hash = "not-a-snapshot-hash"; },
    r => { r.actions[0].arguments.question = QUESTION; },
    r => { r.actions[0].tool = "compare_research_materials"; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(record); mutate(invalid); invalid.actions[0].key = linkActionKey(invalid.actions[0]);
    assert.throws(() => parseLinkResearchTaskRecord(invalid));
  }
});

test("MCP follows a task with a new question, independent settings and same-source refresh without material JSON", async () => {
  const view = childView(), received: unknown[] = [], parentId = view.task.follow_up!.parent_task_id;
  const fixture = await memoryClient({ followUp: async (id, request, options) => { received.push({ id, request, signal: options?.signal instanceof AbortSignal }); return view; }, store: { list: async () => [view.task], load: async () => view.task, delete: async () => undefined } });
  try {
    const tools = (await fixture.client.listTools()).tools;
    const tool = tools.find(item => item.name === "follow_up_research_task"); assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal((tool.inputSchema.properties?.mode as Record<string, unknown>).default, "language");
    assert.equal((tool.inputSchema.properties?.segment_seconds as Record<string, unknown>).default, undefined);
    assert.equal(tool.inputSchema.properties?.urls, undefined); assert.ok(tool.outputSchema?.properties?.answer);
    const response = CallToolResultSchema.parse(await fixture.client.callTool({ name: "follow_up_research_task", arguments: { task_id: parentId, question: CHILD_QUESTION } }));
    assert.deepEqual(response.structuredContent, view);
    assert.deepEqual(received[0], { id: parentId, request: { question: CHILD_QUESTION, mode: "language", language: undefined, totalTimeoutSeconds: undefined, actionTimeoutSeconds: undefined, maxActions: undefined, segmentSeconds: undefined, maxSegments: undefined, maxDetailWindows: undefined, sourceUrls: undefined }, signal: true });
    const fresh = `${VIDEO_ONE}?access_token=temporary-test-access`;
    await fixture.client.callTool({ name: "follow_up_research_task", arguments: { task_id: parentId, question: CHILD_QUESTION, mode: "multimodal", source_urls: [{ source_id: "source:1", url: fresh }], total_timeout_seconds: 300, action_timeout_seconds: 45, max_actions: 4, max_detail_windows: 1 } });
    assert.deepEqual((received[1] as { request: unknown }).request, { question: CHILD_QUESTION, mode: "multimodal", language: undefined, totalTimeoutSeconds: 300, actionTimeoutSeconds: 45, maxActions: 4, segmentSeconds: undefined, maxSegments: undefined, maxDetailWindows: 1, sourceUrls: [{ sourceId: "source:1", url: fresh }] });
    const invalid = CallToolResultSchema.parse(await fixture.client.callTool({ name: "follow_up_research_task", arguments: { task_id: parentId, question: CHILD_QUESTION, urls: [NOTE_URL] } }));
    assert.equal(invalid.isError, true); assert.equal(received.length, 2);
    const listed = CallToolResultSchema.parse(await fixture.client.callTool({ name: "list_research_tasks", arguments: {} }));
    const task = (listed.structuredContent?.tasks as Array<Record<string, unknown>>)[0];
    assert.equal(task.parent_task_id, parentId); assert.equal(task.parent_revision, 7);
  } finally { await fixture.close(); }
});

test("follow-up CLI maps only child settings and waits through the bounded multi-step MCP operation", async () => {
  const id = randomUUID(), fresh = `${VIDEO_ONE}?token=temporary-fixture-access`;
  assert.deepEqual(followUpRequestToToolArguments(id, { question: CHILD_QUESTION, mode: "multimodal", sourceUrls: [{ sourceId: "source:1", url: fresh }] }), {
    task_id: id, question: CHILD_QUESTION, mode: "multimodal", language: undefined, total_timeout_seconds: undefined, action_timeout_seconds: undefined,
    max_actions: undefined, segment_seconds: undefined, max_segments: undefined, max_detail_windows: undefined, source_urls: [{ source_id: "source:1", url: fresh }],
  });
  const calls: unknown[][] = [];
  const client = { callTool: async (...args: unknown[]) => { calls.push(args); return { structuredContent: childView() }; } } as unknown as Pick<Client, "callTool">;
  await createMcpResearchTaskHost(client).callTool("follow_up_research_task", { task_id: id, question: CHILD_QUESTION, total_timeout_seconds: 900 });
  assert.equal((calls[0][2] as { timeout: number }).timeout, 945_000);
});

test("compiled CLI asks a new question from video and note evidence without rereading, and the child survives parent deletion", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst task follow-up CLI "));
  const hook = join(directory, "provider-only-fixture.mjs"), log = join(directory, "requests.jsonl"), input = join(directory, "follow-up.json");
  const taskDirectory = join(directory, "tasks"), sessionDirectory = join(directory, "sessions");
  const store = new LinkResearchTaskStore(taskDirectory), engine = engineHost(sessionDirectory);
  await fs.writeFile(hook, `
import { appendFile } from "node:fs/promises";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input.toString());
  await appendFile(process.env.CATALYST_TEST_REQUEST_LOG, JSON.stringify({path:url.pathname}) + "\\n");
  if (url.hostname !== "provider.fixture" || url.pathname !== "/v1/chat/completions") throw new Error("A saved-text follow-up must not request a source, media or ASR.");
  const prompt = JSON.parse(init.body).messages[0].content;
  if (prompt.includes("PARENT_REPORT_SENTINEL") || prompt.includes("PARENT_FINDING_SENTINEL")) throw new Error("The parent generated report leaked into new-question evidence.");
  if (!prompt.includes(${JSON.stringify(CHILD_QUESTION)})) throw new Error("The child question was not supplied.");
  const quotes = JSON.parse(prompt.split("QUOTE CATALOG:\\n\\n")[1]);
  const first = [...new Map(quotes.map(q => [q.material_id, q])).values()];
  const report = {comparisons:[{claim:"Start with an agent that delegates a bounded operation to a tool.",positions:first.map(q=>({material_id:q.material_id,stance:"supports",citation_ids:[q.id],explanation:"The retained original source material supports delegated execution."})),limitations:["Only the saved source scope was supplied."]}]};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(report)}}]}), {headers:{"Content-Type":"application/json"}});
};
`);
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["dist/research-task-cli.js", ...args], {
      cwd: process.cwd(), timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(hook).href)}`, CATALYST_TASK_DIR: taskDirectory, CATALYST_SESSION_DIR: sessionDirectory,
        CATALYST_TEST_REQUEST_LOG: log, CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_BASE_URL: "https://provider.fixture/v1", STEPFUN_API_KEY: "fixture-unusable-follow-up-key" },
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr }));
  });
  try {
    const parent = await startLinkResearchTask({ urls: [VIDEO_ONE, NOTE_URL], question: QUESTION, segmentSeconds: 120, maxDetailWindows: 0 }, { host: engine.host, store });
    const original = await store.load(parent.task.id);
    for (const action of original.actions) {
      if (!action.source_id || !action.result) continue;
      const leaf = action.result.content_type ? action.result.result as Record<string, unknown> : action.result;
      if (!leaf) continue;
      leaf.analysis = "PARENT_REPORT_SENTINEL";
      for (const finding of leaf.findings as Array<Record<string, unknown>>) finding.statement = "PARENT_FINDING_SENTINEL";
      for (const segment of (leaf.segments ?? []) as Array<Record<string, unknown>>) segment.analysis = "PARENT_REPORT_SENTINEL";
    }
    original.revision++;
    await store.withLock(original.id, () => store.save(original, original.revision - 1));
    const parentPath = join(taskDirectory, `${original.id}.json`), parentBytes = await fs.readFile(parentPath, "utf8");
    await fs.writeFile(input, JSON.stringify({ question: CHILD_QUESTION, totalTimeoutSeconds: 120, actionTimeoutSeconds: 30, maxActions: 2 }));
    const created = await run(["follow-up", original.id, input]); assert.equal(created.code, 0, created.stderr);
    const child = JSON.parse(created.stdout) as LinkResearchTaskView;
    assert.notEqual(child.task.id, original.id); assert.equal(child.task.request.question, CHILD_QUESTION);
    assert.equal(child.task.request.segmentSeconds, 120); assert.equal(child.task.follow_up?.parent_task_id, original.id);
    assert.equal(child.task.follow_up?.parent_revision, original.revision); assert.equal(child.answer_current, true);
    assert.ok(child.answer?.comparisons.length); assert.equal(child.task.actions.length, 1);
    assert.equal(child.task.actions[0].tool, "answer_research_materials"); assert.equal(child.task.budget.reserved_timeout_seconds, 30);
    assert.equal(await fs.readFile(parentPath, "utf8"), parentBytes);
    const events = await fs.readFile(log, "utf8"); assert.equal(events.trim().split("\n").length, 1);
    assert.equal(JSON.parse(events.trim()).path, "/v1/chat/completions");
    const repeated = await run(["continue", child.task.id]); assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), child); assert.equal(await fs.readFile(log, "utf8"), events);
    await store.delete(original.id); await fs.rm(sessionDirectory, { recursive: true, force: true });
    const shown = await run(["show", child.task.id]); assert.equal(shown.code, 0, shown.stderr); assert.deepEqual(JSON.parse(shown.stdout), child.task);
    const independent = await run(["continue", child.task.id]); assert.equal(independent.code, 0, independent.stderr);
    assert.deepEqual(JSON.parse(independent.stdout), child); assert.equal(await fs.readFile(log, "utf8"), events);
    assert.doesNotMatch(`${created.stdout}${repeated.stdout}`, /fixture-unusable-follow-up-key/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
