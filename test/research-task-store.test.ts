import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchResult } from "../src/contracts.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";
import type { ResearchTaskRecord } from "../src/research-task-contracts.js";
import { followupPlanRequestSchema } from "../src/followup-plan-schema.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { ResearchTaskError, ResearchTaskStore } from "../src/research-task-store.js";

const QUESTION = "Which attention mechanisms are explained?";
function video(id: string): ResearchResult {
  const url = `https://www.bilibili.com/video/${id}/`;
  return {
    schema_version: "1.0", status: "partial",
    video: { platform: "bilibili", id, partId: `${id}-cid`, sourceUrl: url, canonicalUrl: url, title: "Attention", durationSeconds: 120 },
    request: { url, question: QUESTION, mode: "language", startSeconds: 0, endSeconds: 120 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform: "bilibili", video_id: id, part_id: `${id}-cid`, url, origin: "fixture" }, time_range: { start_seconds: 0, end_seconds: 15 }, time_basis: "source", precision: "requested_window", content: "Queries and keys determine attention weights.", limitations: [] }],
    findings: [], analysis: null, warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
async function record(store: ResearchTaskStore): Promise<ResearchTaskRecord> {
  const request = followupPlanRequestSchema.parse({ question: QUESTION, materials: ["BV1DTxXzUEvW", "BV1dPeP6REwM"].map(id => ({ kind: "video", result: video(id) })) }) as unknown as FollowupPlanRequest;
  const plan = await planResearchFollowup(request), now = "2026-11-05T01:00:00.000Z";
  assert.equal(plan.status, "planned");
  return {
    schema_version: "1", id: store.newId(), revision: 1, created_at: now, updated_at: now, request, plan,
    selected_keys: null, actions: plan.next_actions.map(action => ({ key: action.key, state: "pending", started_at: null, finished_at: null, result: null, error: null })),
    status: "planned", budget: { max_actions: 3, attempted_actions: 0, total_timeout_seconds: 900, reserved_timeout_seconds: 0 }, stop_reason: plan.stop_reason,
  };
}
function advance(previous: ResearchTaskRecord): ResearchTaskRecord {
  return { ...structuredClone(previous), revision: previous.revision + 1, updated_at: "2026-11-05T01:01:00.000Z" };
}
async function temporary(run: (directory: string, store: ResearchTaskStore) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-tasks-"));
  try { await run(directory, new ResearchTaskStore(directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const hasCode = (expected: string) => (error: unknown) => error instanceof ResearchTaskError && error.code === expected;

test("task snapshots survive a new store instance with private files and preserve the frozen plan", async () => temporary(async (directory, store) => {
  const saved = await record(store);
  await store.withLock(saved.id, () => store.save(saved, null));
  const restarted = new ResearchTaskStore(directory);
  assert.deepEqual(await restarted.load(saved.id), saved);
  assert.deepEqual(await restarted.list(), [saved]);
  assert.deepEqual(await fs.readdir(directory), [`${saved.id}.json`]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(directory, `${saved.id}.json`))).mode & 0o777, 0o600);
  }
}));

test("task save compares revisions and retains the prior atomic snapshot after replacement failure", async () => temporary(async (directory, store) => {
  const first = await record(store); await store.withLock(first.id, () => store.save(first, null));
  const next = advance(first);
  await assert.rejects(store.withLock(first.id, () => store.save(next, null)), hasCode("TASK_CONFLICT"));
  await assert.rejects(store.withLock(first.id, () => store.save({ ...next, revision: 3 }, 1)), hasCode("TASK_CONFLICT"));
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error("Fixture atomic replacement failure"), { code: "EIO" }); };
  try { await assert.rejects(store.withLock(first.id, () => store.save(next, 1)), hasCode("TASK_IO_ERROR")); }
  finally { fs.rename = rename; }
  assert.deepEqual(await store.load(first.id), first);
  assert.deepEqual(await fs.readdir(directory), [`${first.id}.json`]);
  await store.withLock(first.id, () => store.save(next, 1));
  await assert.rejects(store.withLock(first.id, () => store.save(next, 1)), hasCode("TASK_CONFLICT"));
  const changedCreation = { ...advance(next), created_at: "2026-11-04T00:00:00.000Z" };
  await assert.rejects(store.withLock(first.id, () => store.save(changedCreation, 2)), hasCode("TASK_CONFLICT"));
  assert.deepEqual(await store.load(first.id), next);
}));

test("task write strips acquisition secrets and paths without changing public identities or action keys", async () => temporary(async (directory, store) => {
  const saved = await record(store), first = saved.request.materials[0];
  assert.equal(first.kind, "video");
  if (first.kind !== "video") throw new Error("Fixture must contain a video result");
  first.result.video!.sourceUrl += "?token=fixture-private-token";
  first.result.video!.metadata = { authorization: "fixture-authorization", cookie: "fixture-cookie", media_url: "https://cdn.example/image?signature=fixture-signature", local_path: "/fixture/private-media.mp4" };
  const before = structuredClone(saved);
  await store.withLock(saved.id, () => store.save(saved, null));
  const raw = await fs.readFile(join(directory, `${saved.id}.json`), "utf8");
  assert.doesNotMatch(raw, /fixture-private-token|fixture-authorization|fixture-cookie|fixture-signature|private-media/);
  const loaded = await store.load(saved.id);
  assert.deepEqual(loaded.plan.next_actions, saved.plan.next_actions);
  assert.deepEqual(loaded.actions.map(action => action.key), saved.actions.map(action => action.key));
  assert.deepEqual(saved, before);
}));

test("task IDs cannot address traversal paths and unrecognized files are retained", async () => temporary(async (directory, store) => {
  const outside = join(directory, "outside.json"); await fs.writeFile(outside, "protected");
  for (const id of ["../outside", "outside", "../../secret", "", "/tmp/file", `${store.newId()}/../outside`]) {
    await assert.rejects(store.load(id), hasCode("INVALID_TASK_ID"));
    await assert.rejects(store.withLock(id, async () => undefined), hasCode("INVALID_TASK_ID"));
    await assert.rejects(store.delete(id), hasCode("INVALID_TASK_ID"));
  }
  await assert.rejects(store.load(store.newId()), hasCode("TASK_NOT_FOUND"));
  assert.deepEqual(await store.list(), []);
  assert.equal(await fs.readFile(outside, "utf8"), "protected");
}));

test("invalid task schemas, identities, action keys and oversized files fail closed without partial loading", async () => temporary(async (directory, store) => {
  const base = await record(store), path = join(directory, `${base.id}.json`);
  const invalid = ["{broken", JSON.stringify({ ...base, schema_version: "2" }), JSON.stringify({ ...base, id: store.newId() }), JSON.stringify({ ...base, status: "ignore-state" }), JSON.stringify({ ...base, actions: [] }), JSON.stringify({ ...base, budget: { ...base.budget, attempted_actions: 1 } })];
  for (const content of invalid) {
    await fs.writeFile(path, content);
    await assert.rejects(store.load(base.id), hasCode("TASK_CORRUPT"));
    assert.deepEqual(await store.list(), []);
  }
  await fs.writeFile(path, "x".repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(store.load(base.id), hasCode("TASK_TOO_LARGE"));
  assert.deepEqual(await store.list(), []);
  const tooBig = await record(store), first = tooBig.request.materials[0];
  if (first.kind !== "video") throw new Error("Fixture must contain a video result");
  first.result.video!.description = "x".repeat(8 * 1024 * 1024);
  await assert.rejects(store.withLock(tooBig.id, () => store.save(tooBig, null)), hasCode("TASK_TOO_LARGE"));
  assert.deepEqual((await fs.readdir(directory)).sort(), [`${base.id}.json`]);
}));

test("task snapshots reject symlink files, directory aliases and directory-shaped records", async (t) => temporary(async (directory, store) => {
  const base = await record(store), target = join(directory, "target.txt"), path = join(directory, `${base.id}.json`);
  await fs.writeFile(target, JSON.stringify(base));
  try { await fs.symlink(target, path); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows account lacks symlink permission."); return; }
    throw error;
  }
  await assert.rejects(store.load(base.id), hasCode("TASK_CORRUPT"));
  await assert.rejects(store.withLock(base.id, () => store.save(base, null)), hasCode("TASK_CORRUPT"));
  await assert.rejects(store.delete(base.id), hasCode("TASK_CORRUPT"));
  assert.deepEqual(await store.list(), []);
  assert.equal(await fs.readFile(target, "utf8"), JSON.stringify(base));
  const alias = join(directory, "alias"); await fs.symlink(directory, alias, "dir");
  await assert.rejects(new ResearchTaskStore(alias).list(), hasCode("TASK_IO_ERROR"));
  await fs.unlink(path); await fs.mkdir(path);
  await assert.rejects(store.load(base.id), hasCode("TASK_CORRUPT"));
  await assert.rejects(store.delete(base.id), hasCode("TASK_CORRUPT"));
}));

test("task locks reject competing operations and release after success or exception", async () => temporary(async (directory, store) => {
  const saved = await record(store);
  await store.withLock(saved.id, async () => {
    await store.save(saved, null);
    const competitor = new ResearchTaskStore(directory);
    await assert.rejects(competitor.withLock(saved.id, async () => undefined), hasCode("TASK_BUSY"));
    await assert.rejects(competitor.delete(saved.id), hasCode("TASK_BUSY"));
  });
  await assert.rejects(store.withLock(saved.id, async () => { throw new Error("fixture-operation-error"); }), /fixture-operation-error/);
  assert.deepEqual(await fs.readdir(directory), [`${saved.id}.json`]);
  await store.delete(saved.id); assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(store.delete(saved.id), hasCode("TASK_NOT_FOUND"));
}));

test("a separate host process holds a task lock until exit and only its verifiably dead lock is recovered", { timeout: 20_000 }, async () => temporary(async (directory, store) => {
  const id = store.newId();
  const script = "import { ResearchTaskStore } from './src/research-task-store.ts'; await new ResearchTaskStore(process.argv[1]).withLock(process.argv[2], async () => { process.stdout.write('locked'); await new Promise(resolve => setTimeout(resolve, 30000)); });";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory, id], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    const [chunk] = await once(child.stdout, "data"); assert.equal(String(chunk), "locked");
    await assert.rejects(store.withLock(id, async () => undefined), hasCode("TASK_BUSY"));
    child.kill("SIGKILL"); await exited;
    let recovered = false; await store.withLock(id, async () => { recovered = true; });
    assert.equal(recovered, true); assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}));

test("malformed lock owners and recovery guards require inspection instead of elapsed-time stealing", async () => temporary(async (directory, store) => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid; assert.ok(pid); await once(child, "exit");
  const id = store.newId(), path = join(directory, `${id}.lock`);
  await fs.writeFile(path, "{}");
  await assert.rejects(store.withLock(id, async () => undefined), hasCode("TASK_BUSY"));
  assert.equal(await fs.readFile(path, "utf8"), "{}");
  await fs.writeFile(path, JSON.stringify({ pid, token: randomUUID() }));
  await fs.writeFile(`${path}.recovery`, "manual-inspection-required");
  await assert.rejects(store.withLock(id, async () => undefined), hasCode("TASK_BUSY"));
  assert.equal(await fs.readFile(`${path}.recovery`, "utf8"), "manual-inspection-required");
}));

test("100-task capacity refuses new tasks while retaining old records and permitting revisions", async () => temporary(async (directory, store) => {
  const base = await record(store); await store.withLock(base.id, () => store.save(base, null));
  for (let index = 1; index < 100; index++) await fs.writeFile(join(directory, `${store.newId()}.json`), "{}");
  const extra = await record(store);
  await assert.rejects(store.withLock(extra.id, () => store.save(extra, null)), hasCode("TASK_LIMIT_REACHED"));
  assert.equal((await fs.readdir(directory)).length, 100);
  const next = advance(base); await store.withLock(base.id, () => store.save(next, 1));
  assert.equal((await store.load(base.id)).revision, 2);
  await fs.writeFile(join(directory, "keep-me.txt"), "protected");
  assert.ok((await store.list()).length <= 100);
  assert.equal(await fs.readFile(join(directory, "keep-me.txt"), "utf8"), "protected");
}));
