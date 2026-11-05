import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpResearchTaskHost } from "../src/research-task-cli.js";

async function cli(args: string[], directory: string, hook?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...(hook ? ["--import", hook] : []), "--import", "tsx", "src/research-task-cli.ts", ...args], {
      cwd: process.cwd(), timeout: 15_000, maxBuffer: 512 * 1024,
      env: { ...process.env, CATALYST_TASK_DIR: directory, CODEX_VIDEO_PROVIDER: "unsupported-provider-must-not-be-used" },
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr }));
  });
}

test("the reference host passes only structured results and propagates timeout and cancellation to MCP", async () => {
  const calls: unknown[][] = [];
  const partial = { status: "partial", evidence: [{ id: "retained" }] };
  const client = { callTool: async (...args: unknown[]) => { calls.push(args); return { isError: true, structuredContent: partial }; } } as unknown as Pick<Client, "callTool">;
  const host = createMcpResearchTaskHost(client), controller = new AbortController();
  const args = { timeout_seconds: 45, url: "https://example.com" };
  assert.equal(await host.callTool("analyze_video_url", args, controller.signal), partial);
  assert.deepEqual(calls[0], [{ name: "analyze_video_url", arguments: args }, undefined, { timeout: 60_000, signal: controller.signal }]);
  await host.callTool("plan_research_followup", { planning_timeout_seconds: 4 });
  assert.equal((calls[1][2] as { timeout: number }).timeout, 19_000);
  await host.callTool("plan_research_followup", {});
  assert.equal((calls[2][2] as { timeout: number }).timeout, 25_000);
});

test("an unstructured MCP error becomes a generic error without exposing its text", async () => {
  const client = { callTool: async () => ({ isError: true, content: [{ type: "text", text: "private-response-secret" }] }) } as unknown as Pick<Client, "callTool">;
  await assert.rejects(createMcpResearchTaskHost(client).callTool("analyze_video_url", {}), (error: unknown) => {
    assert.equal((error as { code: string }).code, "TASK_TOOL_RESPONSE_INVALID");
    assert.doesNotMatch(String(error), /private-response-secret/); return true;
  });
});

test("rejected MCP requests discard third-party diagnostics, unknown cookies and private local paths", async () => {
  const privateError = new Error('Upstream failure unknownCookie=opaque-private-cookie at /private/cache/account-sensitive/media.mp4');
  const client = { callTool: async () => { throw privateError; } } as unknown as Pick<Client, "callTool">;
  await assert.rejects(createMcpResearchTaskHost(client).callTool("plan_research_followup", {}), (error: unknown) => {
    assert.equal((error as { code: string }).code, "TASK_TOOL_CALL_FAILED");
    assert.notEqual(error, privateError);
    assert.doesNotMatch(String(error), /unknownCookie|opaque-private-cookie|account-sensitive|media\.mp4/);
    return true;
  });
});

test("rejected MCP requests preserve the host's cancellation reason", async () => {
  const controller = new AbortController(), reason = new DOMException("The host cancelled planning.", "AbortError");
  const client = { callTool: async () => { controller.abort(reason); throw new Error("Private transport diagnostic"); } } as unknown as Pick<Client, "callTool">;
  await assert.rejects(createMcpResearchTaskHost(client).callTool("plan_research_followup", {}, controller.signal), (error: unknown) => {
    assert.equal(error, reason); return true;
  });
});

test("read-only CLI commands use the local store without starting a tool server", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-cli-"));
  const hook = join(directory, "reject-spawn.mjs");
  await fs.writeFile(hook, "import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw new Error('Unexpected server spawn')};syncBuiltinESMExports();\n");
  try {
    const help = await cli(["--help"], directory, hook);
    assert.equal(help.code, 0, help.stderr); assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("run ")));
    const listed = await cli(["list"], directory, hook);
    assert.equal(listed.code, 0, listed.stderr); assert.deepEqual(JSON.parse(listed.stdout), { tasks: [] });
    const missing = randomUUID();
    for (const command of ["show", "delete"]) {
      const result = await cli([command, missing], directory, hook);
      assert.equal(result.code, 1); assert.equal(result.stdout, "");
      assert.match(JSON.parse(result.stderr).error.code, /NOT_FOUND/);
      assert.doesNotMatch(result.stderr, /Unexpected server spawn/);
    }
    const invalid = await cli(["show", "../outside"], directory, hook);
    assert.equal(invalid.code, 1); assert.match(JSON.parse(invalid.stderr).error.code, /INVALID/);
    const usage = await cli(["list", "unexpected"], directory, hook);
    assert.equal(usage.code, 1); assert.equal(JSON.parse(usage.stderr).error.code, "TASK_CLI_USAGE");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("invalid and oversized task inputs are rejected before connecting to MCP", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-cli-input-"));
  const hook = join(directory, "reject-spawn.mjs"), input = join(directory, "input.json");
  await fs.writeFile(hook, "import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw new Error('Unexpected server spawn')};syncBuiltinESMExports();\n");
  try {
    for (const value of ["invalid-json-private-response-secret", "[]", "{}", '{"plan":null}']) {
      await fs.writeFile(input, value);
      const result = await cli(["create", input], directory, hook);
      assert.equal(result.code, 1); assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error.code, "TASK_INPUT_INVALID");
      assert.doesNotMatch(result.stderr, /private-response-secret|Unexpected server spawn/);
    }
    await fs.writeFile(input, " ".repeat(2 * 1024 * 1024 + 1));
    const oversized = await cli(["create", input], directory, hook);
    assert.equal(oversized.code, 1); assert.equal(JSON.parse(oversized.stderr).error.code, "TASK_INPUT_TOO_LARGE");
    const directoryInput = await cli(["create", directory], directory, hook);
    assert.equal(directoryInput.code, 1); assert.equal(JSON.parse(directoryInput.stderr).error.code, "TASK_INPUT_INVALID");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
