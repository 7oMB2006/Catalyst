import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LinkResearchTaskView } from "../src/link-research-contracts.js";
import { linkResearchRequestSchema, parseLinkResearchTaskRecord } from "../src/link-research-schema.js";
import { AnyResearchTaskStore, LinkResearchTaskStore } from "../src/link-research-store.js";
import { registerLinkResearchTools, type LinkResearchToolDependencies } from "../src/link-research-tools.js";
import { createMcpResearchTaskHost, linkRequestToToolArguments } from "../src/research-task-cli.js";
import { ResearchTaskStore } from "../src/research-task-store.js";
import { followupPlanRequestSchema } from "../src/followup-plan-schema.js";
import type { ResearchTaskRecord } from "../src/research-task-contracts.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";

const URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/";
const QUESTION = "Which attention mechanism does the source explain?";
function readyView(): LinkResearchTaskView {
  const timestamp = "2026-11-06T01:00:00.000Z";
  return {
    task: parseLinkResearchTaskRecord({
      schema_version: "2", kind: "link_research", id: randomUUID(), revision: 1,
      created_at: timestamp, updated_at: timestamp,
      request: linkResearchRequestSchema.parse({ urls: [URL], question: QUESTION }),
      sources: [{ id: "source:1", url: URL, kind: "video" }], actions: [],
      status: "ready", budget: { max_actions: 12, attempted_actions: 0, total_timeout_seconds: 1800, reserved_timeout_seconds: 0 }, stop_reason: "created",
    }),
    progress: [{ source_id: "source:1", status: "pending", can_continue: true, reason: "Not read yet." }],
    materials: [], comparison: null, comparison_current: false, limitations: [],
  };
}
async function memoryClient(dependencies: LinkResearchToolDependencies) {
  const server = new McpServer({ name: "link-task-test", version: "1.0" });
  registerLinkResearchTools(server, dependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "link-task-test-client", version: "1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function text(response: ReturnType<typeof CallToolResultSchema.parse>): string {
  const content = response.content.find(item => item.type === "text");
  assert.ok(content && content.type === "text"); return content.text;
}

test("MCP link task tools accept links and translate continuation without requiring research material JSON", async () => {
  const view = readyView(), received: unknown[] = [];
  const fixture = await memoryClient({
    start: async (request, options) => { received.push({ request, signal: options?.signal instanceof AbortSignal }); return view; },
    continue: async (id, request, options) => { received.push({ id, request, signal: options?.signal instanceof AbortSignal }); return view; },
    get: async id => { assert.equal(id, view.task.id); return view; },
    store: {
      list: async () => [view.task], load: async id => { assert.equal(id, view.task.id); return view.task; },
      delete: async id => { received.push({ deleted: id }); },
    },
  });
  try {
    const tools = (await fixture.client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["continue_research_task", "delete_research_task", "follow_up_research_task", "get_research_task", "list_research_tasks", "start_research_task"]);
    const startTool = tools.find(tool => tool.name === "start_research_task")!;
    assert.equal(startTool.annotations?.readOnlyHint, false);
    assert.equal(startTool.annotations?.destructiveHint, false);
    assert.equal(startTool.inputSchema.additionalProperties, false);
    assert.equal((startTool.inputSchema.properties?.mode as Record<string, unknown>).default, "language");
    assert.ok(startTool.outputSchema);
    assert.equal(tools.find(tool => tool.name === "get_research_task")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "list_research_tasks")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "delete_research_task")?.annotations?.destructiveHint, true);

    const response = CallToolResultSchema.parse(await fixture.client.callTool({ name: "start_research_task", arguments: { urls: [URL], question: QUESTION } }));
    assert.notEqual(response.isError, true); assert.deepEqual(response.structuredContent, view);
    assert.deepEqual(JSON.parse(text(response)), response.structuredContent);
    assert.deepEqual(received[0], { request: {
      urls: [URL], question: QUESTION, mode: "language", language: undefined,
      totalTimeoutSeconds: 1800, actionTimeoutSeconds: 240, maxActions: 12,
      segmentSeconds: 600, maxSegments: 12, maxDetailWindows: undefined,
    }, signal: true });

    const fresh = `${URL}?p=2&token=fixture-access-secret`;
    const continued = CallToolResultSchema.parse(await fixture.client.callTool({ name: "continue_research_task", arguments: { task_id: view.task.id, max_steps: 1, source_urls: [{ source_id: "source:1", url: fresh }] } }));
    assert.notEqual(continued.isError, true);
    assert.deepEqual(received[1], { id: view.task.id, request: { maxSteps: 1, sourceUrls: [{ sourceId: "source:1", url: fresh }] }, signal: true });
    const changedQuestion = CallToolResultSchema.parse(await fixture.client.callTool({ name: "continue_research_task", arguments: { task_id: view.task.id, question: "A changed question" } }));
    assert.equal(changedQuestion.isError, true); assert.equal(received.length, 2);
    const enlargedBudget = CallToolResultSchema.parse(await fixture.client.callTool({ name: "continue_research_task", arguments: { task_id: view.task.id, total_timeout_seconds: 3600 } }));
    assert.equal(enlargedBudget.isError, true); assert.equal(received.length, 2);
    const restored = CallToolResultSchema.parse(await fixture.client.callTool({ name: "get_research_task", arguments: { task_id: view.task.id } }));
    assert.deepEqual(restored.structuredContent, view);
    const listed = CallToolResultSchema.parse(await fixture.client.callTool({ name: "list_research_tasks", arguments: {} }));
    assert.deepEqual(listed.structuredContent, { tasks: [{ id: view.task.id, revision: 1, question: QUESTION, urls: [URL], status: "ready", stop_reason: "created", budget: view.task.budget, updated_at: view.task.updated_at }] });
    const deleted = CallToolResultSchema.parse(await fixture.client.callTool({ name: "delete_research_task", arguments: { task_id: view.task.id } }));
    assert.deepEqual(deleted.structuredContent, { task_id: view.task.id, deleted: true });
    assert.deepEqual(received[2], { deleted: view.task.id });
  } finally { await fixture.close(); }
});

test("MCP link task failures retain safe codes and never echo unknown provider diagnostics", async () => {
  const fixture = await memoryClient({ get: async () => { throw Object.assign(new Error("Cookie=private-cookie; https://source.example?token=private-token at /private/customer/media.mp4"), { code: "TASK_NOT_FOUND" }); } });
  try {
    const response = CallToolResultSchema.parse(await fixture.client.callTool({ name: "get_research_task", arguments: { task_id: randomUUID() } }));
    assert.equal(response.isError, true); assert.equal(JSON.parse(text(response)).error.code, "TASK_NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(response), /private-cookie|private-token|customer|media\.mp4/);
  } finally { await fixture.close(); }
});

test("the CLI host allows the bounded multi-step task call to outlive one read-action timeout", async () => {
  const calls: unknown[][] = [];
  const client = { callTool: async (...args: unknown[]) => { calls.push(args); return { structuredContent: { task: {} } }; } } as unknown as Pick<Client, "callTool">;
  const host = createMcpResearchTaskHost(client);
  await host.callTool("start_research_task", { total_timeout_seconds: 900, action_timeout_seconds: 60 });
  await host.callTool("continue_research_task", { task_id: randomUUID(), max_steps: 4 });
  assert.equal((calls[0][2] as { timeout: number }).timeout, 945_000);
  assert.equal((calls[1][2] as { timeout: number }).timeout, 3_615_000);
  assert.deepEqual(linkRequestToToolArguments({ urls: [URL], question: QUESTION, mode: "multimodal", totalTimeoutSeconds: 300, actionTimeoutSeconds: 60, maxActions: 4, segmentSeconds: 120, maxSegments: 3, maxDetailWindows: 1 }), {
    urls: [URL], question: QUESTION, mode: "multimodal", language: undefined, total_timeout_seconds: 300,
    action_timeout_seconds: 60, max_actions: 4, segment_seconds: 120, max_segments: 3, max_detail_windows: 1,
  });
});

async function cli(args: string[], directory: string, hook: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["--import", pathToFileURL(hook).href, "--import", "tsx", "src/research-task-cli.ts", ...args], {
      cwd: process.cwd(), timeout: 15_000, maxBuffer: 512 * 1024,
      env: { ...process.env, CATALYST_TASK_DIR: directory, CODEX_VIDEO_PROVIDER: "unsupported-must-not-be-used" },
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr }));
  });
}

test("CLI show, list and delete read both task generations without starting MCP; link inputs fail before connection", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst link CLI "));
  const hook = join(directory, "reject-spawn.mjs"), input = join(directory, "input.json");
  await fs.writeFile(hook, "import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw new Error('Unexpected MCP spawn')};syncBuiltinESMExports();\n");
  try {
    const view = readyView(), store = new LinkResearchTaskStore(directory);
    await store.withLock(view.task.id, () => store.save(view.task, null));
    const request = followupPlanRequestSchema.parse({ question: QUESTION, materials: [{ kind: "session", session_id: randomUUID() }, { kind: "session", session_id: randomUUID() }] }) as unknown as FollowupPlanRequest;
    const legacy: ResearchTaskRecord = {
      schema_version: "1", id: randomUUID(), revision: 1, created_at: view.task.created_at, updated_at: view.task.updated_at, request,
      plan: { schema_version: "1.0", status: "stopped", question: QUESTION, materials: [], gaps: [], next_actions: [], stop_reason: "no_actionable_gaps", budget: { max_actions: 3, max_sources: 2, max_rounds: 2, round: 1, deferred_gaps: 0 }, warnings: [], errors: [], processing: { duration_ms: 0, model_calls: 0, executed_actions: 0 } },
      selected_keys: null, actions: [], status: "planned", budget: { max_actions: 3, attempted_actions: 0, total_timeout_seconds: 900, reserved_timeout_seconds: 0 }, stop_reason: "no_actionable_gaps",
    };
    const legacyStore = new ResearchTaskStore(directory);
    await legacyStore.withLock(legacy.id, () => legacyStore.save(legacy, null));
    const listed = await cli(["list"], directory, hook);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).tasks.map((task: { id: string }) => task.id).sort(), [view.task.id, legacy.id].sort());
    for (const task of [view.task, legacy]) {
      const shown = await cli(["show", task.id], directory, hook);
      assert.equal(shown.code, 0, shown.stderr); assert.equal(JSON.parse(shown.stdout).schema_version, task.schema_version);
    }
    const oldContinue = await cli(["continue", legacy.id], directory, hook);
    assert.equal(oldContinue.code, 1); assert.equal(JSON.parse(oldContinue.stderr).error.code, "TASK_INPUT_INVALID");
    for (const raw of ["{}", "[]", '{"urls":["https://example.com"],"question":"Inspect the source"}', '{"urls":[],"question":"Inspect the source"}', '{"urls":["https://www.bilibili.com/video/BV1DTxXzUEvW/"],"question":"Inspect the source","maxActions":0}']) {
      await fs.writeFile(input, raw);
      const invalid = await cli(["start", input], directory, hook);
      assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stderr).error.code, "TASK_INPUT_INVALID");
      assert.doesNotMatch(invalid.stderr, /Unexpected MCP spawn/);
    }
    await fs.writeFile(input, '{"totalTimeoutSeconds":3600}');
    const budget = await cli(["continue", view.task.id, input], directory, hook);
    assert.equal(budget.code, 1); assert.equal(JSON.parse(budget.stderr).error.code, "TASK_INPUT_INVALID");
    for (const task of [view.task, legacy]) {
      const deleted = await cli(["delete", task.id], directory, hook);
      assert.equal(deleted.code, 0, deleted.stderr); assert.deepEqual(JSON.parse(deleted.stdout), { id: task.id, deleted: true });
    }
    assert.deepEqual(await new AnyResearchTaskStore(directory).list(), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("compiled-independent stdio exposes task tools and reads local progress without provider setup", { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst link stdio "));
  const view = readyView(), store = new LinkResearchTaskStore(directory);
  await store.withLock(view.task.id, () => store.save(view.task, null));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: process.cwd(), stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CATALYST_TASK_DIR: directory, CODEX_VIDEO_PROVIDER: "unsupported-must-not-be-used" },
  });
  const client = new Client({ name: "link-task-stdio-test", version: "1.0" });
  try {
    await client.connect(transport);
    const listed = CallToolResultSchema.parse(await client.callTool({ name: "list_research_tasks", arguments: {} }));
    assert.equal((listed.structuredContent?.tasks as Array<{ id: string }>)[0].id, view.task.id);
    const shown = CallToolResultSchema.parse(await client.callTool({ name: "get_research_task", arguments: { task_id: view.task.id } }));
    assert.notEqual(shown.isError, true); assert.equal((shown.structuredContent?.task as { id: string }).id, view.task.id);
    assert.deepEqual(JSON.parse(text(shown)), shown.structuredContent);
    const missing = CallToolResultSchema.parse(await client.callTool({ name: "continue_research_task", arguments: { task_id: randomUUID() } }));
    assert.equal(missing.isError, true); assert.equal(JSON.parse(text(missing)).error.code, "TASK_NOT_FOUND");
    const invalid = CallToolResultSchema.parse(await client.callTool({ name: "start_research_task", arguments: { urls: ["https://example.com/private?token=fixture-token"], question: QUESTION } }));
    assert.equal(invalid.isError, true); assert.doesNotMatch(JSON.stringify(invalid), /fixture-token/);
    const deleted = CallToolResultSchema.parse(await client.callTool({ name: "delete_research_task", arguments: { task_id: view.task.id } }));
    assert.deepEqual(deleted.structuredContent, { task_id: view.task.id, deleted: true });
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await client.close(); await transport.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("compiled CLI starts from links and a new process continues comparison without rereading sources", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst compiled link CLI "));
  const hook = join(directory, "source-provider-fixtures.mjs"), log = join(directory, "requests.jsonl"), input = join(directory, "request.json");
  // The hook applies to the CLI and its real stdio child. Any unexpected URL fails;
  // no request reaches a network, provider account or platform/media process.
  await fs.writeFile(hook, `
import { appendFile } from "node:fs/promises";
const json = value => new Response(JSON.stringify(value), {headers:{"Content-Type":"application/json"}});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input.toString());
  await appendFile(process.env.CATALYST_TEST_REQUEST_LOG, JSON.stringify({path:url.pathname}) + "\\n");
  if (url.hostname === "api.bilibili.com" && url.pathname === "/x/web-interface/view") return json({code:0,data:{aid:1,cid:2,title:"Caption fixture",desc:"Attention lesson",duration:120,owner:{name:"Fixture",mid:1},pubdate:1,tname:"Knowledge",stat:{},pages:[{cid:2,duration:120,part:"Selected lesson"}]}});
  if (url.hostname === "api.bilibili.com" && url.pathname === "/x/tag/archive/tags") return json({code:0,data:[]});
  if (url.hostname === "api.bilibili.com" && url.pathname === "/x/player/v2") return json({code:0,data:{subtitle:{subtitles:[{subtitle_url:"https://captions.fixture/attention.json",lan:"en"}]}}});
  if (url.hostname === "captions.fixture") return json({body:[{from:0,to:120,content:"Attention compares queries and keys to determine weights."}]});
  if (url.hostname === "provider.fixture" && url.pathname === "/v1/chat/completions") {
    const prompt = JSON.parse(init.body).messages[0].content;
    let report;
    if (prompt.startsWith("Compare the supplied materials")) {
      const quotes = JSON.parse(prompt.split("QUOTE CATALOG:\\n\\n")[1]);
      const first = [...new Map(quotes.map(q => [q.material_id, q])).values()];
      report = {comparisons:[{claim:"Queries and keys determine attention weights.",positions:first.map(q=>({material_id:q.material_id,stance:"supports",citation_ids:[q.id],explanation:"The supplied source caption describes query-key comparison."})),limitations:["Controlled caption fixture."]}]};
    } else report = {analysis:"The source explains query-key attention.",findings:[{statement:"Queries and keys determine attention weights.",evidence_ids:["overview:1:source"],limitations:["Controlled fixture interpretation."]}],relevance_score:1};
    return json({choices:[{message:{content:JSON.stringify(report)}}]});
  }
  throw new Error("Unexpected fixture URL");
};
`);
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["dist/research-task-cli.js", ...args], {
      cwd: process.cwd(), timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(hook).href)}`,
        CATALYST_TASK_DIR: join(directory, "tasks"), CATALYST_SESSION_DIR: join(directory, "sessions"),
        CATALYST_TEST_REQUEST_LOG: log, CODEX_VIDEO_PROVIDER: "stepfun",
        STEPFUN_BASE_URL: "https://provider.fixture/v1", STEPFUN_API_KEY: "fixture-unusable-secret-key",
      },
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr }));
  });
  try {
    await fs.writeFile(input, JSON.stringify({ urls: [URL, "https://www.bilibili.com/video/BV1dPeP6REwM/", "https://www.bilibili.com/video/BV1xx411c7mD/"], question: QUESTION, language: "en", totalTimeoutSeconds: 60, actionTimeoutSeconds: 15, maxActions: 4, segmentSeconds: 120 }));
    const started = await run(["start", input]);
    assert.equal(started.code, 0, started.stderr);
    const first = JSON.parse(started.stdout) as LinkResearchTaskView;
    assert.equal(first.task.status, "partial"); assert.equal(first.task.actions.length, 3);
    assert.equal(first.task.budget.reserved_timeout_seconds, 45); assert.equal(first.comparison, null);
    assert.equal(first.materials.length, 3); assert.ok(first.progress.every(source => source.status === "complete"));
    const before = (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { path: string });
    assert.equal(before.filter(item => item.path === "/x/web-interface/view").length, 3);
    assert.equal(before.filter(item => item.path === "/v1/chat/completions").length, 6);

    const continued = await run(["continue", first.task.id]);
    assert.equal(continued.code, 0, continued.stderr);
    const second = JSON.parse(continued.stdout) as LinkResearchTaskView;
    assert.equal(second.task.id, first.task.id); assert.equal(second.task.status, "completed");
    assert.equal(second.task.actions.length, 4); assert.equal(second.task.actions[3].tool, "compare_research_materials");
    assert.deepEqual(second.task.actions[3].basis, [0, 1, 2]);
    assert.equal(second.task.budget.reserved_timeout_seconds, 60); assert.equal(second.comparison_current, true);
    assert.equal(second.comparison?.materials.length, 3); assert.equal(second.comparison?.comparisons.length, 1);
    assert.equal(second.comparison?.comparisons[0].positions.length, 3);
    const after = await fs.readFile(log, "utf8");
    assert.equal(after.trim().split("\n").length, before.length + 1);
    assert.equal(JSON.parse(after.trim().split("\n").at(-1)!).path, "/v1/chat/completions");

    const repeated = await run(["continue", first.task.id]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), second);
    assert.equal(await fs.readFile(log, "utf8"), after);
    assert.doesNotMatch(`${started.stdout}${continued.stdout}${repeated.stdout}`, /fixture-unusable-secret-key/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
