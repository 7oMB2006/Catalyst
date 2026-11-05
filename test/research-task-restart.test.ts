import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResearchTaskRecord } from "../src/research-task-contracts.js";
import { ResearchTaskStore } from "../src/research-task-store.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VIDEO = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const YOUTUBE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
interface DriverMessage { type: "ready" | "result"; id: string; record?: ResearchTaskRecord; effects?: Array<{ name: string; args: Record<string, unknown> }> }

/** A real child runs the same source modules; only platform/model calls use local fixtures. */
function driverSource(): string {
  const source = (name: string) => JSON.stringify(pathToFileURL(join(ROOT, "src", name)).href);
  return `
import { createResearchTask, runResearchTask } from ${source("research-tasks.ts")};
import { ResearchTaskStore } from ${source("research-task-store.ts")};
import { planResearchFollowup } from ${source("followup-plan.ts")};
const [mode, taskId, directory] = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1000);
const VIDEO = ${JSON.stringify(VIDEO)}, YOUTUBE = ${JSON.stringify(YOUTUBE)};
const question = "What source evidence describes attention?";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
function result(url, start = 0, end = 15) {
  const platform = url === VIDEO ? "bilibili" : "youtube";
  const id = platform === "bilibili" ? "BV1DTxXzUEvW" : "jNQXAC9IVRw";
  const part = platform === "bilibili" ? { partId: "38253823575" } : {};
  return {
    schema_version: "1.0", status: "complete",
    video: { platform, id, ...part, sourceUrl: url, canonicalUrl: url, title: "Restart fixture source", durationSeconds: 120 },
    request: { url, question, mode: "language", startSeconds: start, endSeconds: end },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform, video_id: id, ...(part.partId ? { part_id: part.partId } : {}), url, origin: "restart_fixture" }, time_range: { start_seconds: start, end_seconds: end }, time_basis: "source", precision: "requested_window", content: "Retained original source transcription.", limitations: [] }],
    findings: [], analysis: "Retained bounded source report.", warnings: [], errors: [],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
const input = { question, materials: [{ kind: "video", result: result(VIDEO) }, { kind: "video", result: result(YOUTUBE) }], coverageTarget: "source", maxActions: 2, maxSources: 2, videoWindowSeconds: 30, actionTimeoutSeconds: 15 };
const effects = [], disk = new ResearchTaskStore(directory);
let currentId = taskId;
const host = { callTool: async (name, args) => {
  if (name === "plan_research_followup") return planResearchFollowup(input);
  effects.push({ name, args });
  if (mode === "inflight") { emit({ type: "ready", id: currentId }); await new Promise(() => {}); }
  return result(args.url, args.start_seconds, args.end_seconds);
} };
const store = {
  newId: () => disk.newId(), load: id => disk.load(id), withLock: (id, action) => disk.withLock(id, action),
  save: async (record, revision) => {
    await disk.save(record, revision);
    if (mode === "checkpoint" && record.actions[0].state === "recorded" && record.actions[1].state === "pending") {
      emit({ type: "ready", id: record.id });
      await new Promise(() => {});
    }
  },
};
try {
  if (mode === "resume") {
    const record = await runResearchTask(taskId, undefined, { store, host });
    emit({ type: "result", id: taskId, record, effects });
  } else {
    const task = await createResearchTask({ plan: input, totalTimeoutSeconds: 30 }, { store, host });
    currentId = task.id;
    await runResearchTask(task.id, task.plan.next_actions.map(action => action.key), { store, host });
    throw new Error("The interruption fixture did not reach its expected checkpoint.");
  }
} catch (error) { process.stderr.write(String(error.stack ?? error)); process.exitCode = 1; }
finally { clearInterval(keepAlive); }
`;
}

function launch(script: string, directory: string, mode: "checkpoint" | "inflight" | "resume", id = "") {
  const child = spawn(process.execPath, ["--import", "tsx", script, mode, id, directory], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", diagnostics = "", settled = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const message = new Promise<DriverMessage>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Restart fixture timed out: ${diagnostics}`)); }, 15_000);
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    child.on("error", fail);
    child.stderr!.on("data", (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-64 * 1024); });
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 1024 * 1024) { fail(new Error("Restart fixture output exceeded its bound.")); child.kill("SIGKILL"); return; }
      for (let newline = output.indexOf("\n"); newline >= 0; newline = output.indexOf("\n")) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as DriverMessage;
          if (!settled && parsed.type === (mode === "resume" ? "result" : "ready")) { settled = true; clearTimeout(timer); resolve(parsed); }
        } catch { fail(new Error(`Invalid restart fixture response: ${diagnostics}`)); }
      }
    });
    child.once("close", (code, signal) => fail(new Error(`Restart fixture exited before its checkpoint (${code ?? signal}): ${diagnostics}`)));
  });
  return { child, closed, message };
}
async function stop(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}
async function temporary(work: (directory: string, script: string) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-restart-"));
  try {
    const script = join(directory, "driver.mjs"); await fs.writeFile(script, driverSource());
    await work(directory, script);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("a fresh process resumes only the pending action after SIGKILL beyond a successful result checkpoint", { timeout: 20_000 }, async () => temporary(async (directory, script) => {
  const first = launch(script, directory, "checkpoint");
  let id: string;
  try { id = (await first.message).id; }
  finally { await stop(first.child, first.closed); }
  const store = new ResearchTaskStore(directory), checkpoint = await store.load(id!);
  assert.deepEqual(checkpoint.actions.map((action) => action.state), ["recorded", "pending"]);
  assert.equal(checkpoint.budget.attempted_actions, 1); assert.equal(checkpoint.budget.reserved_timeout_seconds, 15);
  assert.deepEqual(checkpoint.selected_keys, checkpoint.plan.next_actions.map((action) => action.key));
  const preservedResult = checkpoint.actions[0].result;
  const second = launch(script, directory, "resume", id!);
  try {
    const response = await second.message, exit = await second.closed;
    assert.equal(exit.code, 0); assert.ok(response.record); assert.equal(response.record.status, "completed");
    assert.deepEqual(response.effects?.map((call) => [call.name, call.args.url]), [["analyze_video_url", YOUTUBE]]);
    assert.deepEqual(response.record.actions.map((action) => action.state), ["recorded", "recorded"]);
    assert.deepEqual(response.record.actions[0].result, preservedResult);
    assert.equal(response.record.budget.attempted_actions, 2); assert.equal(response.record.budget.reserved_timeout_seconds, 30);
    assert.ok(response.record.revision > checkpoint.revision); assert.deepEqual(await store.load(id!), response.record);
  } finally { await stop(second.child, second.closed); }
}));

test("a fresh process marks a SIGKILL during a host call unknown without replaying any action", { timeout: 20_000 }, async () => temporary(async (directory, script) => {
  const first = launch(script, directory, "inflight");
  let id: string;
  try { id = (await first.message).id; }
  finally { await stop(first.child, first.closed); }
  const store = new ResearchTaskStore(directory), checkpoint = await store.load(id!);
  assert.deepEqual(checkpoint.actions.map((action) => action.state), ["running", "pending"]);
  assert.equal(checkpoint.budget.attempted_actions, 1); assert.equal(checkpoint.budget.reserved_timeout_seconds, 15);
  const second = launch(script, directory, "resume", id!);
  try {
    const response = await second.message, exit = await second.closed;
    assert.equal(exit.code, 0); assert.ok(response.record); assert.equal(response.record.status, "needs_attention");
    assert.deepEqual(response.record.actions.map((action) => action.state), ["unknown", "pending"]);
    assert.deepEqual(response.effects, []); assert.deepEqual(response.record.budget, checkpoint.budget);
    assert.deepEqual(await store.load(id!), response.record);
  } finally { await stop(second.child, second.closed); }
}));
