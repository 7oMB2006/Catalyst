import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResearchSessionError, ResearchSessionStore, type ResearchSessionRecord } from "../src/research-session-store.js";

function record(store: ResearchSessionStore): ResearchSessionRecord {
  const id = store.newId(), now = "2026-11-03T01:00:00.000Z";
  const request = { url: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17", question: "Which mechanisms are explained?", mode: "multimodal" as const, maxDetailWindows: 0 };
  return {
    schema_version: "1", id, revision: 1, created_at: now, updated_at: now, compatibility: "fixture-engine-v1", request,
    result: {
      schema_version: "1.0", status: "partial", video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: request.url, canonicalUrl: request.url, title: "Selected part17", durationSeconds: 1200 }, request,
      capabilities: { metadata: { status: "available" }, captions: { status: "auth_required" }, media: { status: "available" }, comments: { status: "not_requested" } },
      evidence: [{ id: "overview:1:asr", kind: "asr", source: { platform: "bilibili", video_id: "BV1DTxXzUEvW", part_id: "38253823575", url: request.url, origin: "windowed_provider_asr" }, time_range: { start_seconds: 0, end_seconds: 600 }, time_basis: "source", precision: "requested_window", content: "A generated source transcript.", limitations: ["Fixture transcript"] }],
      findings: [], analysis: null, warnings: [], errors: [], processing: { duration_ms: 100, stage_durations_ms: {}, provider: "stepfun", usage: null, download_bytes: 1000 },
      session: { id, revision: 1, created_at: now, updated_at: now, reused_segments: 0, processed_segments: 1 },
      plan: { strategy: "segmented_overview_then_detail", requested_window: { start_seconds: 0, end_seconds: 1200 }, segment_seconds: 600, overview_windows: [{ start_seconds: 0, end_seconds: 600 }, { start_seconds: 600, end_seconds: 1200 }], max_detail_windows: 0, detail_window_seconds: 120, max_download_bytes: 512 * 1024 * 1024, window_timeout_seconds: 180 },
      segments: [
        { id: "overview:1", phase: "overview", window: { start_seconds: 0, end_seconds: 600 }, status: "complete", basis: "audio_video", evidence_ids: ["overview:1:asr"], analysis: "A completed segment." },
        { id: "overview:2", phase: "overview", window: { start_seconds: 600, end_seconds: 1200 }, status: "failed", basis: "audio_video", evidence_ids: [], analysis: null, error: "TIMEOUT" },
      ],
      coverage: { overview: [{ start_seconds: 0, end_seconds: 600 }], detail: [], unreviewed: [{ start_seconds: 600, end_seconds: 1200 }], overview_complete: false, limitations: [] },
    },
  };
}
async function temporary(run: (directory: string, store: ResearchSessionStore) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-sessions-"));
  try { await run(directory, new ResearchSessionStore(directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function hasCode(expected: string) { return (error: unknown) => error instanceof ResearchSessionError && error.code === expected; }
function advance(previous: ResearchSessionRecord): ResearchSessionRecord {
  const next = structuredClone(previous); next.revision++; next.updated_at = "2026-11-03T01:01:00.000Z";
  next.result.session!.revision = next.revision; next.result.session!.updated_at = next.updated_at;
  return next;
}

test("local snapshots survive a new store instance and preserve transcripts, selected-part identity and progress", async () => temporary(async (directory, store) => {
  const saved = record(store);
  await store.withLock(saved.id, () => store.save(saved, null));
  const restarted = new ResearchSessionStore(directory);
  assert.deepEqual(await restarted.load(saved.id), saved);
  assert.deepEqual(await restarted.list(), [{ id: saved.id, revision: 1, created_at: saved.created_at, updated_at: saved.updated_at, title: "Selected part17", question: saved.request.question, status: "partial", overview_complete: false, completed_segments: 1, total_segments: 2 }]);
  assert.deepEqual(await fs.readdir(directory), [`${saved.id}.json`]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(directory, `${saved.id}.json`))).mode & 0o777, 0o600);
  }
}));

test("save compares revisions, advances once and leaves the previous atomic snapshot intact on failure", async () => temporary(async (directory, store) => {
  const first = record(store); await store.withLock(first.id, () => store.save(first, null));
  const next = advance(first);
  await assert.rejects(store.withLock(first.id, () => store.save(next, null)), hasCode("SESSION_CONFLICT"));
  await assert.rejects(store.withLock(first.id, () => store.save({ ...next, revision: 3 }, 1)), hasCode("SESSION_CORRUPT"));
  await store.withLock(first.id, () => store.save(next, 1));
  await assert.rejects(store.withLock(first.id, () => store.save(next, 1)), hasCode("SESSION_CONFLICT"));
  const tooBig = advance(next); tooBig.result.analysis = "x".repeat(8 * 1024 * 1024);
  await assert.rejects(store.withLock(first.id, () => store.save(tooBig, 2)), hasCode("SESSION_TOO_LARGE"));
  assert.deepEqual(await store.load(first.id), next);
  assert.deepEqual(await fs.readdir(directory), [`${first.id}.json`]);
}));

test("missing, traversal and non-UUID identifiers cannot address arbitrary files", async () => temporary(async (directory, store) => {
  const outside = join(directory, "outside.json"); await fs.writeFile(outside, "protected");
  for (const id of ["../outside", "outside", "../../secret", "", "/tmp/file", `${store.newId()}/../outside`]) {
    await assert.rejects(store.load(id), hasCode("INVALID_SESSION_ID"));
    await assert.rejects(store.withLock(id, async () => undefined), hasCode("INVALID_SESSION_ID"));
    await assert.rejects(store.delete(id), hasCode("INVALID_SESSION_ID"));
  }
  await assert.rejects(store.load(store.newId()), hasCode("SESSION_NOT_FOUND"));
  assert.equal(await fs.readFile(outside, "utf8"), "protected");
}));

test("invalid JSON, request types, schema versions and mismatching metadata are rejected without partial loading", async () => temporary(async (directory, store) => {
  const base = record(store), path = join(directory, `${base.id}.json`);
  const invalid = ["{broken", JSON.stringify({ ...base, schema_version: "2" }), JSON.stringify({ ...base, request: { ...base.request, mode: "ignore-mode" } }), JSON.stringify({ ...base, id: store.newId() }), JSON.stringify({ ...base, result: { ...base.result, session: { ...base.result.session, revision: 99 } } }), JSON.stringify({ ...base, result: { ...base.result, follow_up: { parent_session_id: base.id, parent_revision: 1, reused_evidence_ids: [] } } })];
  for (const content of invalid) {
    await fs.writeFile(path, content);
    await assert.rejects(store.load(base.id), hasCode("SESSION_CORRUPT"));
    assert.deepEqual(await store.list(), []);
  }
  await fs.writeFile(path, "x".repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(store.load(base.id), hasCode("SESSION_TOO_LARGE"));
  assert.deepEqual(await store.list(), []);
}));

test("symlink snapshots and directory paths are rejected without following the link", async (t) => temporary(async (directory, store) => {
  const base = record(store), target = join(directory, "target.txt"), path = join(directory, `${base.id}.json`);
  await fs.writeFile(target, JSON.stringify(base));
  try { await fs.symlink(target, path); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows account lacks symlink permission."); return; }
    throw error;
  }
  await assert.rejects(store.load(base.id), hasCode("SESSION_CORRUPT"));
  await assert.rejects(store.withLock(base.id, () => store.save(base, null)), hasCode("SESSION_CORRUPT"));
  await assert.rejects(store.delete(base.id), hasCode("SESSION_CORRUPT"));
  assert.deepEqual(await store.list(), []);
  assert.equal(await fs.readFile(target, "utf8"), JSON.stringify(base));
  const alias = join(directory, "alias"); await fs.symlink(directory, alias, "dir");
  await assert.rejects(new ResearchSessionStore(alias).list(), hasCode("SESSION_IO_ERROR"));
}));

test("a live session lock rejects competing work and deletion, then releases after success or error", async () => temporary(async (directory, store) => {
  const saved = record(store);
  await store.withLock(saved.id, async () => {
    await store.save(saved, null);
    const secondProcessView = new ResearchSessionStore(directory);
    await assert.rejects(secondProcessView.withLock(saved.id, async () => undefined), hasCode("SESSION_BUSY"));
    await assert.rejects(secondProcessView.delete(saved.id), hasCode("SESSION_BUSY"));
  });
  await assert.rejects(store.withLock(saved.id, async () => { throw new Error("fixture-operation-error"); }), /fixture-operation-error/);
  assert.deepEqual(await fs.readdir(directory), [`${saved.id}.json`]);
  await store.delete(saved.id);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(store.delete(saved.id), hasCode("SESSION_NOT_FOUND"));
}));

test("a verifiably exited process's lock can be recovered, while a malformed or recovery lock is retained", async () => temporary(async (directory, store) => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid; assert.ok(pid);
  await once(child, "exit");
  const id = store.newId(), path = join(directory, `${id}.lock`);
  await fs.writeFile(path, JSON.stringify({ pid, token: randomUUID() }));
  let ran = false;
  await store.withLock(id, async () => { ran = true; });
  assert.equal(ran, true); assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(path, "{}");
  await assert.rejects(store.withLock(id, async () => undefined), hasCode("SESSION_BUSY"));
  assert.equal(await fs.readFile(path, "utf8"), "{}");
  await fs.writeFile(path, JSON.stringify({ pid, token: randomUUID() }));
  await fs.writeFile(`${path}.recovery`, "manual-inspection-required");
  await assert.rejects(store.withLock(id, async () => undefined), hasCode("SESSION_BUSY"));
  assert.equal(await fs.readFile(`${path}.recovery`, "utf8"), "manual-inspection-required");
}));

test("100-session capacity rejects new creation without deleting old records, but permits updating an existing one", async () => temporary(async (directory, store) => {
  const base = record(store); await store.withLock(base.id, () => store.save(base, null));
  for (let index = 1; index < 100; index++) await fs.writeFile(join(directory, `${store.newId()}.json`), "{}");
  const extra = record(store);
  await assert.rejects(store.withLock(extra.id, () => store.save(extra, null)), hasCode("SESSION_LIMIT_REACHED"));
  assert.equal((await fs.readdir(directory)).length, 100);
  const next = advance(base); await store.withLock(base.id, () => store.save(next, 1));
  assert.equal((await store.load(base.id)).revision, 2);
  const extraPath = join(directory, `${store.newId()}.json`); await fs.writeFile(extraPath, "{}");
  assert.ok((await store.list()).length <= 100);
}));
