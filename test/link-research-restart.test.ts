import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LinkResearchTaskView } from "../src/link-research-contracts.js";
import { LinkResearchTaskStore } from "../src/link-research-store.js";
import { VIDEO_ONE, VIDEO_TWO } from "./helpers/link-research-fixtures.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Node requires a file URL for an absolute --import path on Windows. Resolution also
// preserves spaces in the checkout path without depending on shell quoting.
const TSX_IMPORT = import.meta.resolve("tsx");
interface DriverMessage {
  type: "ready" | "result";
  id: string;
  view?: LinkResearchTaskView;
  effects?: Array<{ name: string; args: Record<string, unknown> }>;
  windows?: Array<{ url: string; start?: number; end?: number }>;
}

/** Only providers and platform dependencies are fixtures; engines and both disk stores are real. */
function driverSource(): string {
  const source = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
  return `
import { join } from "node:path";
import { startLinkResearchTask, continueLinkResearchTask } from ${source("src/link-research.ts")};
import { LinkResearchTaskStore } from ${source("src/link-research-store.ts")};
import { engineHost, VIDEO_ONE, VIDEO_TWO, QUESTION } from ${source("test/helpers/link-research-fixtures.ts")};
const [mode, taskId, directory] = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1000);
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const disk = new LinkResearchTaskStore(join(directory, "task snapshots"));
const engine = engineHost(join(directory, "video sessions"));
const effects = [];
let currentId = taskId;
const store = {
  newId: () => disk.newId(), load: id => disk.load(id), withLock: (id, operation) => disk.withLock(id, operation),
  save: async (record, revision) => {
    await disk.save(record, revision);
    currentId = record.id;
    if (mode === "checkpoint" && record.actions.length === 1 && record.actions[0].state === "recorded") {
      emit({ type: "ready", id: record.id });
      await new Promise(() => {});
    }
  },
};
const host = { callTool: async (name, args, signal) => {
  effects.push({ name, args });
  if (mode === "inflight") {
    // The runner has committed intent and allowance before entering the host.
    emit({ type: "ready", id: currentId });
    await new Promise(() => {});
  }
  return engine.host.callTool(name, args, signal);
} };
try {
  if (mode === "resume") {
    const view = await continueLinkResearchTask(taskId, { maxSteps: 2 }, { store, host });
    emit({ type: "result", id: taskId, view, effects, windows: engine.windows });
  } else {
    await startLinkResearchTask({ urls: [VIDEO_ONE, VIDEO_TWO], question: QUESTION, mode: "language", segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0, actionTimeoutSeconds: 15, totalTimeoutSeconds: 45, maxActions: 3 }, { store, host });
    throw new Error("The interruption fixture did not reach its expected checkpoint.");
  }
} catch (error) { process.stderr.write(String(error.stack ?? error)); process.exitCode = 1; }
finally { clearInterval(keepAlive); }
`;
}

function launch(script: string, directory: string, mode: "checkpoint" | "inflight" | "resume", id = "") {
  const child = spawn(process.execPath, ["--import", TSX_IMPORT, script, mode, id, directory], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", diagnostics = "", settled = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const message = new Promise<DriverMessage>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Link research restart fixture timed out: ${diagnostics}`)); }, 15_000);
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    child.on("error", fail);
    child.stderr!.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-64 * 1024); });
    child.stdout!.on("data", chunk => {
      output += String(chunk);
      if (output.length > 2 * 1024 * 1024) { fail(new Error("Link research restart fixture output exceeded its bound.")); child.kill("SIGKILL"); return; }
      for (let newline = output.indexOf("\n"); newline >= 0; newline = output.indexOf("\n")) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as DriverMessage;
          if (!settled && parsed.type === (mode === "resume" ? "result" : "ready")) { settled = true; clearTimeout(timer); resolve(parsed); }
        } catch { fail(new Error(`Invalid link research restart response: ${diagnostics}`)); }
      }
    });
    child.once("close", (code, signal) => fail(new Error(`Link research restart fixture exited before its checkpoint (${code ?? signal}): ${diagnostics}`)));
  });
  return { child, closed, message };
}
async function stop(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}
async function temporary(work: (directory: string, script: string) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst link restart "));
  try {
    const script = join(directory, "research driver with spaces.mjs"); await fs.writeFile(script, driverSource());
    await work(directory, script);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("link research resumes a pending source and builds comparison in a new process after SIGKILL past the first receipt", { timeout: 35_000 }, async () => temporary(async (directory, script) => {
  const first = launch(script, directory, "checkpoint");
  let id: string;
  try { id = (await first.message).id; }
  finally { await stop(first.child, first.closed); }
  const store = new LinkResearchTaskStore(join(directory, "task snapshots")), checkpoint = await store.load(id!);
  assert.equal(checkpoint.schema_version, "2"); assert.deepEqual(checkpoint.actions.map(action => action.state), ["recorded"]);
  assert.equal(checkpoint.actions[0].arguments.url, VIDEO_ONE); assert.equal(checkpoint.sources[1].url, VIDEO_TWO);
  assert.equal(checkpoint.budget.attempted_actions, 1); assert.equal(checkpoint.budget.reserved_timeout_seconds, 15);
  assert.equal(checkpoint.budget.max_actions, 3); assert.equal(checkpoint.budget.total_timeout_seconds, 45);
  const originalReceipt = structuredClone(checkpoint.actions[0]);
  const second = launch(script, directory, "resume", id!);
  try {
    const response = await second.message, exit = await second.closed;
    assert.equal(exit.code, 0); assert.ok(response.view);
    const { task, progress, comparison_current } = response.view;
    assert.equal(task.status, "completed"); assert.equal(comparison_current, true); assert.deepEqual(progress.map(source => source.status), ["complete", "complete"]);
    assert.deepEqual(response.effects?.map(call => [call.name, call.args.url]), [["analyze_long_video_url", VIDEO_TWO], ["compare_research_materials", undefined]]);
    assert.deepEqual(response.windows?.map(window => [window.url, window.start, window.end]), [[VIDEO_TWO, 0, 120]], "the completed source incurs no new media or model work");
    assert.deepEqual(task.actions[0], originalReceipt, "the first source's exact acknowledged receipt survives the process death");
    assert.deepEqual(task.actions.map(action => action.state), ["recorded", "recorded", "recorded"]);
    assert.equal(task.budget.attempted_actions, 3); assert.equal(task.budget.reserved_timeout_seconds, 45);
    assert.equal(task.budget.max_actions, checkpoint.budget.max_actions); assert.equal(task.budget.total_timeout_seconds, checkpoint.budget.total_timeout_seconds);
    assert.ok(task.revision > checkpoint.revision); assert.deepEqual(await store.load(id!), task);
  } finally { await stop(second.child, second.closed); }
}));

test("link research marks a SIGKILL after durable intent unknown in a new process without dispatch or budget reset", { timeout: 35_000 }, async () => temporary(async (directory, script) => {
  const first = launch(script, directory, "inflight");
  let id: string;
  try { id = (await first.message).id; }
  finally { await stop(first.child, first.closed); }
  const store = new LinkResearchTaskStore(join(directory, "task snapshots")), checkpoint = await store.load(id!);
  assert.deepEqual(checkpoint.actions.map(action => action.state), ["running"]);
  assert.equal(checkpoint.actions[0].result, null); assert.equal(checkpoint.budget.attempted_actions, 1); assert.equal(checkpoint.budget.reserved_timeout_seconds, 15);
  const second = launch(script, directory, "resume", id!);
  try {
    const response = await second.message, exit = await second.closed;
    assert.equal(exit.code, 0); assert.ok(response.view);
    const { task, progress } = response.view;
    assert.equal(task.status, "needs_attention"); assert.deepEqual(task.actions.map(action => action.state), ["unknown"]);
    assert.equal(task.actions[0].result, null); assert.equal(task.actions[0].error?.code, "OUTCOME_UNKNOWN");
    assert.deepEqual(response.effects, []); assert.deepEqual(response.windows, []); assert.deepEqual(progress.map(source => source.status), ["pending", "pending"]);
    assert.deepEqual(task.budget, checkpoint.budget); assert.ok(task.revision > checkpoint.revision); assert.deepEqual(await store.load(id!), task);
  } finally { await stop(second.child, second.closed); }
}));
