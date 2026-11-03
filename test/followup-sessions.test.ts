import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Evidence, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoRequest, LongVideoResult } from "../src/long-video-contracts.js";
import { longVideoResultSchema } from "../src/long-video-schema.js";
import { ResearchSessionError, ResearchSessionStore } from "../src/research-session-store.js";
import { followUpLongVideoResearch, resumeLongVideoResearch, startLongVideoResearch, type FollowUpResearchOptions } from "../src/research-sessions.js";

const URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const REQUEST: LongVideoRequest = { url: URL, question: "Original question about attention mechanisms", mode: "multimodal", language: "zh", maxDetailWindows: 0 };
const NEW_QUESTION = "How does sparse attention reduce computation?";
function source(): SourceContext {
  return {
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: URL, canonicalUrl: URL, title: "Attention course part17", durationSeconds: 1200, metadata: { part: 17 } },
    captions: { status: "auth_required", kind: "unknown", cues: [] }, comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "auth_required" }, media: { status: "not_requested" }, comments: { status: "disabled" } }, warnings: [],
  };
}
function evidenceIn(prompt: string): Evidence[] {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const start = prompt.lastIndexOf(marker); assert.notEqual(start, -1);
  return JSON.parse(prompt.slice(start + marker.length));
}
function fixture(selected = source(), label = "parent") {
  const calls = { resolves: [] as LongVideoRequest[], acquired: [] as Array<[number | undefined, number | undefined]>, transcribed: [] as string[], media: [] as string[], text: [] as string[] };
  const reply = (prompt: string) => {
    const evidence = evidenceIn(prompt).find((item) => item.kind !== "metadata"); assert.ok(evidence);
    return JSON.stringify({ analysis: `${label} report cites ${evidence.id}.`, findings: [{ statement: `${label} observation.`, evidence_ids: [evidence.id], limitations: ["Fixture observation"] }], relevance_score: 2, focus_offset_seconds: label === "parent" ? 60 : 400 });
  };
  const deps: LongVideoDependencies = {
    resolve: async (request) => { calls.resolves.push({ ...request }); return structuredClone(selected); },
    acquireWindow: async (_video, request) => { calls.acquired.push([request.startSeconds, request.endSeconds]); return { path: `/fixture/${label}-${calls.acquired.length}.mp4`, bytes: 1024, dispose: async () => {} }; },
    prepareWindow: async (path) => ({ path, dispose: async () => {} }),
    transcribe: async (path) => { calls.transcribed.push(path); return `Source speech about sparse attention from ${path}.`; },
    analyzeMedia: async (_path, prompt) => { calls.media.push(prompt); return reply(prompt); },
    analyzeText: async (prompt) => { calls.text.push(prompt); return reply(prompt); },
  };
  return { deps, calls };
}
async function temporary(run: (directory: string, store: ResearchSessionStore) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-followup-session-"));
  try { await run(directory, new ResearchSessionStore(directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function idOf(result: LongVideoResult): string { assert.ok(result.session); return result.session.id; }
function hasCode(expected: string) { return (error: unknown) => error instanceof ResearchSessionError && error.code === expected; }
async function read(directory: string, id: string) { return fs.readFile(join(directory, `${id}.json`), "utf8"); }

test("a new question saves independent reports and lineage, reusing text without media or ASR calls", async () => temporary(async (directory, store) => {
  const first = fixture(), original = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps });
  assert.equal(original.status, "complete");
  const parent = idOf(original), raw = await read(directory, parent), next = fixture(source(), "followup");
  const result = await followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store: new ResearchSessionStore(directory), dependencies: next.deps });
  assert.equal(result.status, "complete"); assert.notEqual(idOf(result), parent);
  assert.equal(result.request.question, NEW_QUESTION); assert.equal(result.request.mode, "language");
  assert.equal(result.plan?.max_detail_windows, 0); assert.equal(result.video?.partId, "38253823575");
  assert.equal(result.session?.reused_segments, 0); assert.equal(result.session?.processed_segments, 2);
  assert.deepEqual(result.follow_up, { parent_session_id: parent, parent_revision: original.session!.revision, reused_evidence_ids: ["overview:1:asr", "overview:2:asr"] });
  assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.transcribed, []); assert.deepEqual(next.calls.media, []);
  assert.equal(next.calls.text.length, 3); assert.equal(result.processing.download_bytes, 0);
  assert.ok(next.calls.text.every((prompt) => prompt.includes(NEW_QUESTION)));
  assert.ok(next.calls.text.every((prompt) => !prompt.includes("parent report") && !prompt.includes(REQUEST.question)));
  assert.equal(await read(directory, parent), raw);
  const restarted = new ResearchSessionStore(directory), child = await restarted.load(idOf(result));
  assert.deepEqual(child.result, result); assert.ok(longVideoResultSchema.safeParse(result).success);
  const listed = (await restarted.list()).find((entry) => entry.id === child.id);
  assert.equal(listed?.question, NEW_QUESTION); assert.equal(listed?.parent_session_id, parent); assert.equal(listed?.parent_revision, original.session!.revision);
  const ids = new Set(result.evidence.map((e) => e.id));
  assert.ok(result.findings.every((finding) => finding.evidence_ids.every((id) => ids.has(id))));
}));

test("multimodal follow-up uses new text relevance and focus and acquires only its chosen detail clip", async () => temporary(async (directory, store) => {
  const first = fixture(), original = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps }), parent = idOf(original), raw = await read(directory, parent);
  const next = fixture(source(), "followup");
  const result = await followUpLongVideoResearch(parent, { question: "Which formula is visible for sparse attention?", mode: "multimodal", maxDetailWindows: 1, detailWindowSeconds: 120 }, { store, dependencies: next.deps });
  assert.equal(result.status, "complete"); assert.equal(result.request.mode, "multimodal");
  assert.deepEqual(next.calls.acquired, [[340, 460]]); assert.equal(next.calls.transcribed.length, 1); assert.equal(next.calls.media.length, 1);
  assert.equal(next.calls.text.length, 3); assert.equal(result.processing.download_bytes, 1024);
  assert.deepEqual(result.coverage.detail, [{ start_seconds: 340, end_seconds: 460 }]);
  assert.deepEqual(result.segments.filter((segment) => segment.phase === "overview").map((segment) => segment.basis), ["audio", "audio"]);
  assert.equal(result.segments.find((segment) => segment.phase === "detail")?.basis, "audio_video");
  assert.equal(await read(directory, parent), raw);
  assert.deepEqual((await new ResearchSessionStore(directory).load(idOf(result))).result, result);
}));

test("a failed child text window resumes from its own durable raw material after the parent is deleted", async () => temporary(async (directory, store) => {
  const original = await startLongVideoResearch(REQUEST, { store, dependencies: fixture().deps }), parent = idOf(original);
  const next = fixture(source(), "followup"), analyze = next.deps.analyzeText;
  next.deps.analyzeText = async (...args) => {
    if (!args[0].includes("SYNTHESIS:") && evidenceIn(args[0])[0].id === "overview:2:asr") throw Object.assign(new Error("Fixture text failure"), { code: "UPSTREAM_ERROR" });
    return analyze(...args);
  };
  const partial = await followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store, dependencies: next.deps });
  assert.equal(partial.status, "partial"); const child = idOf(partial);
  assert.deepEqual(partial.segments.map((segment) => segment.status), ["complete", "failed"]);
  await store.delete(parent);
  const last = fixture(source(), "resumed"), result = await resumeLongVideoResearch(child, {}, { store: new ResearchSessionStore(directory), dependencies: last.deps });
  assert.equal(result.status, "complete"); assert.equal(idOf(result), child); assert.equal(result.session?.reused_segments, 1); assert.equal(result.session?.processed_segments, 1);
  assert.deepEqual(last.calls.acquired, []); assert.deepEqual(last.calls.transcribed, []); assert.deepEqual(last.calls.media, []); assert.equal(last.calls.text.length, 2);
  assert.deepEqual(result.follow_up, partial.follow_up);
  assert.deepEqual((await store.load(child)).result, result);
}));

test("invalid follow-up settings fail before parent access and cannot overwrite the source selection", async () => temporary(async (directory, store) => {
  const next = fixture(), unknown = store.newId();
  const invalid: unknown[] = [
    { question: " " }, { question: "ok" }, { question: NEW_QUESTION, mode: "vision" },
    { question: NEW_QUESTION, startSeconds: 30 }, { question: NEW_QUESTION, language: "en" },
    { question: NEW_QUESTION, maxDetailWindows: 1 }, { question: NEW_QUESTION, mode: "multimodal", maxDetailWindows: 0 },
    { question: NEW_QUESTION, timeoutSeconds: 2 }, { question: NEW_QUESTION, windowTimeoutSeconds: 1 }, { question: NEW_QUESTION, maxDownloadMB: 1 },
  ];
  for (const input of invalid) await assert.rejects(followUpLongVideoResearch(unknown, input as FollowUpResearchOptions, { store, dependencies: next.deps }), hasCode("INVALID_REQUEST"));
  assert.deepEqual(next.calls.resolves, []); assert.deepEqual(await fs.readdir(directory), []);
}));

test("a changed provider configuration rejects follow-up before source work and preserves the parent", async () => temporary(async (directory, store) => {
  const provider = process.env.CODEX_VIDEO_PROVIDER, model = process.env.STEPFUN_VIDEO_MODEL;
  process.env.CODEX_VIDEO_PROVIDER = "stepfun"; process.env.STEPFUN_VIDEO_MODEL = "fixture-parent-model";
  try {
    const original = await startLongVideoResearch(REQUEST, { store, dependencies: fixture().deps }), parent = idOf(original), raw = await read(directory, parent);
    process.env.STEPFUN_VIDEO_MODEL = "fixture-changed-model";
    const next = fixture();
    await assert.rejects(followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store, dependencies: next.deps }), hasCode("SESSION_INCOMPATIBLE"));
    assert.deepEqual(next.calls.resolves, []); assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.text, []);
    assert.equal(await read(directory, parent), raw); assert.equal((await store.list()).length, 1);
  } finally {
    if (provider === undefined) delete process.env.CODEX_VIDEO_PROVIDER; else process.env.CODEX_VIDEO_PROVIDER = provider;
    if (model === undefined) delete process.env.STEPFUN_VIDEO_MODEL; else process.env.STEPFUN_VIDEO_MODEL = model;
  }
}));

test("a changed selected part is rejected before model work and does not save a child", async () => temporary(async (directory, store) => {
  const original = await startLongVideoResearch(REQUEST, { store, dependencies: fixture().deps }), parent = idOf(original), raw = await read(directory, parent);
  const changed = source(); changed.video.partId = "foreign-cid"; const next = fixture(changed);
  const result = await followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store, dependencies: next.deps });
  assert.equal(result.status, "unavailable"); assert.ok(result.errors.some((issue) => issue.code === "SESSION_INCOMPATIBLE"));
  assert.ok(!result.session); assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.text, []);
  assert.equal(await read(directory, parent), raw); assert.equal((await store.list()).length, 1);
}));

test("a parent in use rejects snapshot creation while a child releases the parent lock before analysis", async () => temporary(async (_directory, store) => {
  const original = await startLongVideoResearch(REQUEST, { store, dependencies: fixture().deps }), parent = idOf(original);
  await store.withLock(parent, () => assert.rejects(followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store, dependencies: fixture().deps }), hasCode("SESSION_BUSY")));
  const next = fixture(), resolve = next.deps.resolve;
  next.deps.resolve = async (...args) => { await store.delete(parent); return resolve(...args); };
  const child = await followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store, dependencies: next.deps });
  assert.equal(child.status, "complete"); await assert.rejects(store.load(parent), hasCode("SESSION_NOT_FOUND"));
  assert.equal((await store.list()).length, 1); assert.equal(child.follow_up?.parent_session_id, parent);
}));

test("child checkpoint storage failures stop paid stages while preserving the parent revision", async () => temporary(async (directory, store) => {
  const original = await startLongVideoResearch(REQUEST, { store, dependencies: fixture().deps }), parent = idOf(original), raw = await read(directory, parent);
  store.save = async () => { throw new ResearchSessionError("SESSION_IO_ERROR", "Fixture disk full"); };
  const next = fixture(), result = await followUpLongVideoResearch(parent, { question: NEW_QUESTION }, { store, dependencies: next.deps });
  assert.ok(result.errors.some((issue) => issue.code === "SESSION_SAVE_FAILED")); assert.ok(!result.session);
  assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.transcribed, []); assert.deepEqual(next.calls.media, []); assert.deepEqual(next.calls.text, []);
  assert.equal(await read(directory, parent), raw); assert.equal((await store.list()).length, 1);
}));
