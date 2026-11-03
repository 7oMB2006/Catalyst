import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Evidence, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoRequest, LongVideoResult } from "../src/long-video-contracts.js";
import { ResearchSessionError, ResearchSessionStore } from "../src/research-session-store.js";
import { resumeLongVideoResearch, sanitizeSessionResult, sessionCompatibility, startLongVideoResearch } from "../src/research-sessions.js";

const URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17&share_source=copy_web&vd_source=private-share-value";
const CANONICAL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const REQUEST: LongVideoRequest = { url: URL, question: "本集注意力机制各自解决什么问题？", mode: "multimodal", language: "zh", maxDetailWindows: 0 };

function source(duration = 1800): SourceContext {
  return {
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: URL, canonicalUrl: CANONICAL, title: "Attention course part17", durationSeconds: duration, metadata: { part: 17, part_title: "Selfattention" } },
    captions: { status: "auth_required", kind: "unknown", cues: [] },
    comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "auth_required" }, media: { status: "not_requested" }, comments: { status: "disabled" } }, warnings: [],
  };
}
function evidenceIn(prompt: string): Evidence[] {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const start = prompt.lastIndexOf(marker); assert.notEqual(start, -1);
  return JSON.parse(prompt.slice(start + marker.length));
}
function answer(prompt: string): string {
  const evidence = evidenceIn(prompt).find((item) => item.kind !== "metadata"); assert.ok(evidence);
  return JSON.stringify({ analysis: `A source observation from ${evidence.id}.`, findings: [{ statement: `Supported observation in ${evidence.id}.`, evidence_ids: [evidence.id] }], relevance_score: 2, focus_offset_seconds: 60 });
}
function fixture(selected = source(), label = "first") {
  const calls = { resolves: [] as string[], acquired: [] as Array<[number | undefined, number | undefined]>, transcribed: [] as string[], media: [] as string[], text: [] as string[], created: [] as string[], disposed: [] as string[] };
  const owned = (path: string) => {
    calls.created.push(path);
    return { path, dispose: async () => { assert.ok(!calls.disposed.includes(path)); calls.disposed.push(path); } };
  };
  const deps: LongVideoDependencies = {
    resolve: async (request) => { calls.resolves.push(request.url); return structuredClone(selected); },
    acquireWindow: async (_video, request) => {
      calls.acquired.push([request.startSeconds, request.endSeconds]);
      return { ...owned(`/fixture/${label}-${calls.acquired.length}.mp4`), bytes: 1024, width: 854, height: 480, fps: 30 };
    },
    prepareWindow: async (path, _mode, detail) => owned(`${path}.${detail}.prepared.mp4`),
    transcribe: async (path) => { calls.transcribed.push(path); return `${label} generated language evidence.`; },
    analyzeMedia: async (_path, prompt) => { calls.media.push(prompt); return answer(prompt); },
    analyzeText: async (prompt) => { calls.text.push(prompt); return answer(prompt); },
  };
  return { deps, calls };
}
async function temporary(run: (directory: string, store: ResearchSessionStore) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-session-workflow-"));
  try { await run(directory, new ResearchSessionStore(directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function idOf(result: LongVideoResult): string { assert.ok(result.session); return result.session.id; }
function hasCode(expected: string) { return (error: unknown) => error instanceof ResearchSessionError && error.code === expected; }
async function rawRecord(directory: string, id: string) { return fs.readFile(join(directory, `${id}.json`), "utf8"); }
async function failedMiddle(store: ResearchSessionStore) {
  const first = fixture();
  const analyze = first.deps.analyzeMedia;
  first.deps.analyzeMedia = async (...args) => {
    const raw = await analyze(...args);
    if (evidenceIn(args[1])[0].id === "overview:2:source") throw Object.assign(new Error("Fixture provider interruption"), { code: "UPSTREAM_ERROR", retryable: true });
    return raw;
  };
  const result = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps });
  assert.equal(result.status, "partial"); assert.deepEqual(result.segments.map((item) => item.status), ["complete", "failed", "complete"]);
  assert.deepEqual([...first.calls.created].sort(), [...first.calls.disposed].sort());
  return result;
}

test("a fresh store instance resumes only the failed interval and advertises durable unified citations", async () => temporary(async (directory, store) => {
  const previous = await failedMiddle(store), id = idOf(previous);
  const saved = await new ResearchSessionStore(directory).load(id);
  assert.equal(saved.result.video?.partId, "38253823575");
  assert.equal(saved.result.video?.metadata?.part, 17);
  assert.equal(saved.request.url, CANONICAL);
  assert.deepEqual(saved.result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  const next = fixture(source(), "restarted");
  const result = await resumeLongVideoResearch(id, {}, { store: new ResearchSessionStore(directory), dependencies: next.deps });
  assert.equal(result.status, "complete");
  assert.deepEqual(next.calls.acquired, [[600, 1200]]); assert.equal(next.calls.transcribed.length, 1); assert.equal(next.calls.media.length, 1);
  assert.equal(result.session?.id, id); assert.ok(result.session!.revision > previous.session!.revision);
  assert.equal(result.session?.reused_segments, 2); assert.equal(result.session?.processed_segments, 1);
  assert.equal(result.processing.download_bytes, 1024);
  assert.equal(result.coverage.overview_complete, true); assert.deepEqual(result.coverage.unreviewed, []);
  const ids = new Set(result.evidence.map((item) => item.id)); assert.equal(ids.size, result.evidence.length);
  assert.ok(result.findings.every((finding) => finding.evidence_ids.every((ref) => ids.has(ref))));
  const final = await store.load(id);
  assert.deepEqual(final.result, result); assert.equal(final.revision, result.session?.revision);
  assert.deepEqual([...next.calls.created].sort(), [...next.calls.disposed].sort());
}));

test("the full 71-minute selected part resumes its only failed overview and preserves the 76-second tail", async () => temporary(async (directory, store) => {
  const first = fixture(source(4276)), analyze = first.deps.analyzeMedia;
  first.deps.analyzeMedia = async (...args) => {
    const raw = await analyze(...args);
    if (evidenceIn(args[1])[0].id === "overview:3:source") throw Object.assign(new Error("Fixture one-window provider interruption"), { code: "UPSTREAM_ERROR", retryable: true });
    return raw;
  };
  const previous = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps }), id = idOf(previous);
  assert.equal(previous.status, "partial");
  assert.equal(previous.plan?.overview_windows.length, 8);
  assert.equal(previous.segments.filter((segment) => segment.status === "complete").length, 7);
  assert.equal(previous.segments[2].status, "failed");
  assert.deepEqual(previous.coverage.unreviewed, [{ start_seconds: 1200, end_seconds: 1800 }]);
  assert.deepEqual(previous.coverage.overview.at(-1), { start_seconds: 4200, end_seconds: 4276 });
  const restarted = new ResearchSessionStore(directory), durable = await restarted.load(id);
  assert.equal(durable.result.segments.filter((segment) => segment.status === "complete").length, 7);
  const next = fixture(source(4276), "full-course-resume");
  const result = await resumeLongVideoResearch(id, {}, { store: restarted, dependencies: next.deps });
  assert.equal(result.status, "complete");
  assert.deepEqual(next.calls.acquired, [[1200, 1800]]);
  assert.equal(next.calls.transcribed.length, 1); assert.equal(next.calls.media.length, 1); assert.equal(next.calls.text.length, 1);
  assert.equal(result.session?.reused_segments, 7); assert.equal(result.session?.processed_segments, 1);
  assert.equal(result.video?.partId, "38253823575"); assert.equal(result.video?.metadata?.part, 17); assert.equal(result.video?.canonicalUrl, CANONICAL);
  assert.equal(result.coverage.overview_complete, true); assert.deepEqual(result.coverage.unreviewed, []);
  assert.deepEqual(result.coverage.overview, result.plan?.overview_windows); assert.equal(result.coverage.overview.length, 8);
  assert.deepEqual(result.coverage.overview.at(-1), { start_seconds: 4200, end_seconds: 4276 });
  const ids = new Set(result.evidence.map((item) => item.id)); assert.equal(ids.size, result.evidence.length);
  assert.ok(result.findings.every((finding) => finding.evidence_ids.every((ref) => ids.has(ref))));
  assert.deepEqual((await restarted.load(id)).result, result);
  assert.deepEqual([...first.calls.created].sort(), [...first.calls.disposed].sort());
  assert.deepEqual([...next.calls.created].sort(), [...next.calls.disposed].sort());
}));

test("processed and reused counters include overview and detail phases without charging old windows", async () => temporary(async (_directory, store) => {
  const request = { ...REQUEST, maxDetailWindows: 1 }, first = fixture(source(1200));
  const result = await startLongVideoResearch(request, { store, dependencies: first.deps });
  assert.equal(result.status, "complete"); assert.equal(result.session?.processed_segments, 3); assert.equal(result.session?.reused_segments, 0);
  assert.equal(first.calls.acquired.length, 3); assert.equal(first.calls.transcribed.length, 3);
  const next = fixture(source(1200), "complete-resume");
  const resumed = await resumeLongVideoResearch(idOf(result), {}, { store, dependencies: next.deps });
  assert.equal(resumed.status, "complete"); assert.equal(resumed.session?.reused_segments, 3); assert.equal(resumed.session?.processed_segments, 0);
  assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.transcribed, []); assert.deepEqual(next.calls.media, []);
  assert.equal(resumed.processing.download_bytes, 0); assert.equal(next.calls.text.length, 1);
}));

test("disk snapshots recursively redact environment secrets, signed URLs, credential fields and media paths", async () => temporary(async (directory, store) => {
  const key = "CATALYST_FIXTURE_SECRET", old = process.env[key], secret = "fixture-environment-secret-12345";
  process.env[key] = secret;
  try {
    const selected = source(600);
    selected.video.metadata = {
      part: 17, nested: { authorization: "Bearer nested-auth", api_key: "nested-api-value", media_url: "https://cdn.example.test/media.mp4?signature=private-signature", file_path: "/private/local/source.mp4", audioPath: "/private/local/audio.m4a", videoPath: "/private/local/video.mp4", filePath: "/private/local/prepared.mp4", localPath: "/private/local/local.mp4", note: `Normal text contains ${secret}.`, more: [{ cookie: "session-cookie-private", safe_note: "Retained source context" }] },
    };
    const first = fixture(selected);
    first.deps.transcribe = async () => `Spoken source text containing ${secret} and https://cdn.example.test/file.mp4?token=private-inline-token.`;
    const result = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps });
    assert.equal(result.status, "complete");
    const raw = await rawRecord(directory, idOf(result));
    assert.doesNotMatch(raw, /fixture-environment-secret|private-share-value|vd_source|share_source|private-signature|private-inline-token|nested-auth|nested-api-value|session-cookie-private|\/private\/local\//);
    assert.match(raw, /Retained source context/); assert.match(raw, /\[redacted\]/);
    assert.equal((await store.load(idOf(result))).request.url, CANONICAL);
    const cleaned = sanitizeSessionResult(result);
    assert.doesNotMatch(JSON.stringify(cleaned), /fixture-environment-secret|private-inline-token/);
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
}));

test("a changed provider model refuses continuation before acquisition and preserves the saved revision", async () => temporary(async (directory, store) => {
  const oldProvider = process.env.CODEX_VIDEO_PROVIDER, oldModel = process.env.STEPFUN_VIDEO_MODEL;
  process.env.CODEX_VIDEO_PROVIDER = "stepfun"; process.env.STEPFUN_VIDEO_MODEL = "fixture-model-before";
  try {
    const first = fixture(source(600));
    const result = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps }), id = idOf(result);
    const raw = await rawRecord(directory, id), compatibility = sessionCompatibility();
    process.env.STEPFUN_VIDEO_MODEL = "fixture-model-after";
    assert.notEqual(sessionCompatibility(), compatibility);
    const next = fixture(source(600));
    await assert.rejects(resumeLongVideoResearch(id, {}, { store, dependencies: next.deps }), hasCode("SESSION_INCOMPATIBLE"));
    assert.deepEqual(next.calls.resolves, []); assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.media, []);
    assert.equal(await rawRecord(directory, id), raw);
  } finally {
    if (oldProvider === undefined) delete process.env.CODEX_VIDEO_PROVIDER; else process.env.CODEX_VIDEO_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.STEPFUN_VIDEO_MODEL; else process.env.STEPFUN_VIDEO_MODEL = oldModel;
  }
}));

test("changing the effective default ASR language rejects resume before source or model calls", async () => temporary(async (directory, store) => {
  const oldProvider = process.env.CODEX_VIDEO_PROVIDER, oldLanguage = process.env.STEPFUN_ASR_LANGUAGE;
  process.env.CODEX_VIDEO_PROVIDER = "stepfun"; process.env.STEPFUN_ASR_LANGUAGE = "zh";
  try {
    const request = { ...REQUEST, language: undefined }, first = fixture(source(1200));
    const analyze = first.deps.analyzeMedia;
    first.deps.analyzeMedia = async (...args) => {
      const raw = await analyze(...args);
      if (evidenceIn(args[1])[0].id === "overview:2:source") throw Object.assign(new Error("Fixture interruption"), { code: "UPSTREAM_ERROR" });
      return raw;
    };
    const result = await startLongVideoResearch(request, { store, dependencies: first.deps }), id = idOf(result);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.segments.map((segment) => segment.status), ["complete", "failed"]);
    const raw = await rawRecord(directory, id), compatibility = (await store.load(id)).compatibility;
    assert.equal(compatibility, sessionCompatibility(request));
    process.env.STEPFUN_ASR_LANGUAGE = "en";
    assert.notEqual(sessionCompatibility(request), compatibility);
    const next = fixture(source(1200));
    await assert.rejects(resumeLongVideoResearch(id, {}, { store: new ResearchSessionStore(directory), dependencies: next.deps }), hasCode("SESSION_INCOMPATIBLE"));
    assert.deepEqual(next.calls.resolves, []); assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.transcribed, []);
    assert.deepEqual(next.calls.media, []); assert.deepEqual(next.calls.text, []);
    assert.equal(await rawRecord(directory, id), raw);
  } finally {
    if (oldProvider === undefined) delete process.env.CODEX_VIDEO_PROVIDER; else process.env.CODEX_VIDEO_PROVIDER = oldProvider;
    if (oldLanguage === undefined) delete process.env.STEPFUN_ASR_LANGUAGE; else process.env.STEPFUN_ASR_LANGUAGE = oldLanguage;
  }
}));

test("an explicit research language overrides a changed ASR fallback when continuing unfinished windows", async () => temporary(async (directory, store) => {
  const oldProvider = process.env.CODEX_VIDEO_PROVIDER, oldLanguage = process.env.STEPFUN_ASR_LANGUAGE;
  process.env.CODEX_VIDEO_PROVIDER = "stepfun"; process.env.STEPFUN_ASR_LANGUAGE = "zh";
  try {
    const request = { ...REQUEST, language: "en" }, first = fixture(source(1200));
    const analyze = first.deps.analyzeMedia;
    first.deps.analyzeMedia = async (...args) => {
      const raw = await analyze(...args);
      if (evidenceIn(args[1])[0].id === "overview:2:source") throw Object.assign(new Error("Fixture interruption"), { code: "UPSTREAM_ERROR" });
      return raw;
    };
    const result = await startLongVideoResearch(request, { store, dependencies: first.deps }), id = idOf(result);
    assert.equal(result.status, "partial");
    const compatibility = (await store.load(id)).compatibility;
    assert.equal(compatibility, sessionCompatibility(request));
    process.env.STEPFUN_ASR_LANGUAGE = "ja";
    assert.equal(sessionCompatibility(request), compatibility);
    const next = fixture(source(1200), "explicit-language-resume"), transcribe = next.deps.transcribe;
    next.deps.transcribe = async (...args) => { assert.equal(args[2], "en"); return transcribe(...args); };
    const resumed = await resumeLongVideoResearch(id, {}, { store: new ResearchSessionStore(directory), dependencies: next.deps });
    assert.equal(resumed.status, "complete");
    assert.deepEqual(next.calls.acquired, [[600, 1200]]); assert.equal(next.calls.transcribed.length, 1); assert.equal(next.calls.media.length, 1);
    assert.equal(resumed.session?.reused_segments, 1); assert.equal(resumed.session?.processed_segments, 1);
    assert.equal((await store.load(id)).compatibility, compatibility);
  } finally {
    if (oldProvider === undefined) delete process.env.CODEX_VIDEO_PROVIDER; else process.env.CODEX_VIDEO_PROVIDER = oldProvider;
    if (oldLanguage === undefined) delete process.env.STEPFUN_ASR_LANGUAGE; else process.env.STEPFUN_ASR_LANGUAGE = oldLanguage;
  }
}));

test("compatibility normalizes StepFun's default language and ignores its unused fallback for Gemini", () => {
  const oldProvider = process.env.CODEX_VIDEO_PROVIDER, oldLanguage = process.env.STEPFUN_ASR_LANGUAGE;
  try {
    process.env.CODEX_VIDEO_PROVIDER = "stepfun"; delete process.env.STEPFUN_ASR_LANGUAGE;
    const defaultCompatibility = sessionCompatibility();
    process.env.STEPFUN_ASR_LANGUAGE = "zh";
    assert.equal(sessionCompatibility(), defaultCompatibility);
    process.env.CODEX_VIDEO_PROVIDER = "gemini";
    const geminiCompatibility = sessionCompatibility();
    process.env.STEPFUN_ASR_LANGUAGE = "en";
    assert.equal(sessionCompatibility(), geminiCompatibility);
  } finally {
    if (oldProvider === undefined) delete process.env.CODEX_VIDEO_PROVIDER; else process.env.CODEX_VIDEO_PROVIDER = oldProvider;
    if (oldLanguage === undefined) delete process.env.STEPFUN_ASR_LANGUAGE; else process.env.STEPFUN_ASR_LANGUAGE = oldLanguage;
  }
});

test("a fresh Xiaohongshu access token is used for acquisition without changing or persisting source identity", async () => temporary(async (directory, store) => {
  const canonical = "https://www.xiaohongshu.com/explore/6aaaa3300000000025035966";
  const original = `${canonical}?xsec_token=original-private-access`, refreshed = `${canonical}?xsec_token=refreshed-private-access`;
  const selected = source(1200);
  selected.video = { ...selected.video, platform: "xiaohongshu", id: "6aaaa3300000000025035966", partId: undefined, sourceUrl: original, canonicalUrl: canonical };
  const request = { ...REQUEST, url: original }, first = fixture(selected);
  const analyze = first.deps.analyzeMedia;
  first.deps.analyzeMedia = async (...args) => {
    const raw = await analyze(...args);
    if (evidenceIn(args[1])[0].id === "overview:2:source") throw Object.assign(new Error("Fixture interruption"), { code: "UPSTREAM_ERROR" });
    return raw;
  };
  const previous = await startLongVideoResearch(request, { store, dependencies: first.deps });
  const id = idOf(previous), next = fixture({ ...selected, video: { ...selected.video, sourceUrl: refreshed } }, "new-access");
  const acquire = next.deps.acquireWindow;
  next.deps.acquireWindow = async (...args) => { assert.equal(args[1].url, refreshed); return acquire(...args); };
  const result = await resumeLongVideoResearch(id, { url: refreshed }, { store, dependencies: next.deps });
  assert.equal(result.status, "complete"); assert.deepEqual(next.calls.resolves, [refreshed]);
  assert.deepEqual(next.calls.acquired, [[600, 1200]]); assert.equal(result.video?.canonicalUrl, canonical);
  assert.doesNotMatch(await rawRecord(directory, id), /original-private-access|refreshed-private-access|xsec_token/);
}));

test("source revalidation failure returns saved reports and leaves the durable record unchanged", async () => temporary(async (directory, store) => {
  const previous = await failedMiddle(store), id = idOf(previous), raw = await rawRecord(directory, id);
  const next = fixture();
  next.deps.resolve = async () => { throw Object.assign(new Error("Fixture source is temporarily blocked"), { code: "ACCESS_BLOCKED" }); };
  const result = await resumeLongVideoResearch(id, {}, { store, dependencies: next.deps });
  assert.equal(result.status, "partial"); assert.deepEqual(result.segments, previous.segments); assert.deepEqual(result.evidence, previous.evidence);
  assert.ok(result.errors.some((error) => error.code === "ACCESS_BLOCKED"));
  assert.equal(result.session?.revision, previous.session?.revision);
  assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.media, []);
  assert.equal(await rawRecord(directory, id), raw);
}));

test("a changed selected part is rejected without replacing the existing research record", async () => temporary(async (directory, store) => {
  const previous = await failedMiddle(store), id = idOf(previous), raw = await rawRecord(directory, id);
  const selected = source(); selected.video.partId = "different-part-cid";
  const next = fixture(selected);
  const result = await resumeLongVideoResearch(id, {}, { store, dependencies: next.deps });
  assert.ok(result.errors.some((error) => error.code === "SESSION_INCOMPATIBLE"));
  assert.equal(result.session?.id, id); assert.equal(result.session?.revision, previous.session?.revision);
  assert.deepEqual(next.calls.acquired, []); assert.deepEqual(next.calls.media, []); assert.deepEqual(next.calls.text, []);
  assert.equal(await rawRecord(directory, id), raw);
}));

test("a checkpoint write failure stops later costly windows and advertises only the last durable revision", async () => temporary(async (_directory, store) => {
  const save = store.save.bind(store);
  store.save = async (record, revision) => {
    if (record.revision >= 3) throw new ResearchSessionError("SESSION_IO_ERROR", "Fixture full disk");
    return save(record, revision);
  };
  const first = fixture();
  const result = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps });
  assert.equal(result.status, "partial"); assert.ok(result.errors.some((error) => error.code === "SESSION_SAVE_FAILED"));
  assert.equal(result.session?.revision, 2);
  assert.deepEqual(first.calls.acquired, [[0, 600], [600, 1200]]); assert.equal(first.calls.transcribed.length, 2); assert.equal(first.calls.media.length, 2); assert.equal(first.calls.text.length, 0);
  const durable = await store.load(idOf(result));
  assert.equal(durable.revision, 2); assert.deepEqual(durable.result.segments.map((segment) => segment.status), ["complete", "pending", "pending"]);
  assert.deepEqual([...first.calls.created].sort(), [...first.calls.disposed].sort());
}));

test("an active continuation excludes another continuation or deletion until the operation releases its lock", async () => temporary(async (_directory, store) => {
  const previous = await failedMiddle(store), id = idOf(previous), next = fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), blocked = new Promise<void>((resolve) => { release = resolve; });
  const resolve = next.deps.resolve;
  next.deps.resolve = async (...args) => { enter(); await blocked; return resolve(...args); };
  const running = resumeLongVideoResearch(id, {}, { store, dependencies: next.deps });
  try {
    await entered;
    const competing = fixture();
    await assert.rejects(resumeLongVideoResearch(id, {}, { store, dependencies: competing.deps }), hasCode("SESSION_BUSY"));
    await assert.rejects(store.delete(id), hasCode("SESSION_BUSY"));
    assert.deepEqual(competing.calls.resolves, []); assert.deepEqual(competing.calls.acquired, []);
  } finally { release(); }
  assert.equal((await running).status, "complete");
  await store.delete(id); await assert.rejects(store.load(id), hasCode("SESSION_NOT_FOUND"));
}));

test("saveSession false performs research without creating a local record or lock", async () => temporary(async (directory, store) => {
  const first = fixture(source(600));
  const result = await startLongVideoResearch(REQUEST, { store, dependencies: first.deps, saveSession: false });
  assert.equal(result.status, "complete"); assert.ok(!result.session);
  assert.equal(first.calls.acquired.length, 1); assert.deepEqual(await fs.readdir(directory), []);
}));
