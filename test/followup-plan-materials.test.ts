import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionContext, ResearchResult } from "../src/contracts.js";
import type { NoteResearchResult, XiaohongshuResearchResult } from "../src/note-contracts.js";
import type { ComparisonInput } from "../src/comparison-contracts.js";
import type { LongVideoRequest, LongVideoResult } from "../src/long-video-contracts.js";
import { preparePlanningMaterials } from "../src/followup-plan-materials.js";
import { ResearchSessionStore, type ResearchSessionRecord } from "../src/research-session-store.js";

const QUESTION = "Explain the attention diagram", BV = "BV1DTxXzUEvW", CID = "38253823575", NOTE = "6aaaa3300000000025035966";
const context = (): ExecutionContext => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
const run = (inputs: ComparisonInput[], question = QUESTION) => preparePlanningMaterials(inputs, question, context());
function video(): ResearchResult {
  const url = `https://www.bilibili.com/video/${BV}/?p=17`;
  return {
    schema_version: "1.0", status: "complete", video: { platform: "bilibili", id: BV, partId: CID, sourceUrl: `${url}&token=private`, canonicalUrl: url, title: "Attention", durationSeconds: 120 },
    request: { url, question: QUESTION, mode: "language", startSeconds: 0, endSeconds: 60 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform: "bilibili", video_id: BV, part_id: CID, url, origin: "fixture" }, time_range: { start_seconds: 0, end_seconds: 15 }, time_basis: "source", precision: "requested_window", content: "Queries and keys determine attention weights.", limitations: [] }],
    findings: [], analysis: "OLD_FINAL_ANSWER", warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
function note(): NoteResearchResult {
  const url = `https://www.xiaohongshu.com/explore/${NOTE}`;
  return {
    schema_version: "1.0", status: "complete", note: { platform: "xiaohongshu", id: NOTE, sourceUrl: `${url}?xsec_token=private`, canonicalUrl: url, title: "Attention", description: "Body", contentType: "image_note", imageCount: 3 },
    request: { url, question: QUESTION, mode: "combined" },
    capabilities: { body: { status: "available" }, images: { status: "available" }, ocr: { status: "available" }, comments: { status: "unsupported" } },
    evidence: [{ id: "note:body", kind: "note_text", source: { platform: "xiaohongshu", note_id: NOTE, url, origin: "platform_note_body" }, page: null, content: "Body does not prove any image page was read.", limitations: [] }, ...[1, 3].map((page) => ({ id: `ocr:${page}`, kind: "image_text" as const, source: { platform: "xiaohongshu" as const, note_id: NOTE, url, origin: "fixture" }, page, content: `Page ${page} OCR`, limitations: [] }))],
    findings: [], analysis: "OLD_FINAL_ANSWER", warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
function longVideo(complete = false): LongVideoResult {
  const raw = video(), first = { start_seconds: 0, end_seconds: 600 }, second = { start_seconds: 600, end_seconds: 1200 };
  raw.video!.durationSeconds = 1200; raw.request = { ...raw.request, mode: "vision", endSeconds: 1200, segmentSeconds: 600, maxDetailWindows: 0 } as LongVideoRequest;
  raw.status = complete ? "complete" : "partial";
  raw.evidence = [first, second].map((window, index) => ({ ...raw.evidence[0], id: `overview:${index + 1}:source`, kind: "visual", time_range: window, content: undefined }));
  return { ...raw,
    plan: { strategy: "segmented_overview_then_detail", requested_window: { start_seconds: 0, end_seconds: 1200 }, segment_seconds: 600, overview_windows: [first, second], max_detail_windows: 0, detail_window_seconds: 120, max_download_bytes: 512 * 1024 * 1024, window_timeout_seconds: 180 },
    segments: [first, second].map((window, index) => ({ id: `overview:${index + 1}`, phase: "overview", window, status: index === 0 || complete ? "complete" : "failed", basis: "video", evidence_ids: [`overview:${index + 1}:source`], analysis: index === 0 || complete ? "Inspected this window; no relevant finding." : null })),
    coverage: { overview: complete ? [first, second] : [first], detail: [], unreviewed: complete ? [] : [second], overview_complete: complete, limitations: [] },
  };
}
async function save(store: ResearchSessionStore, result: LongVideoResult): Promise<ResearchSessionRecord> {
  const now = new Date().toISOString(), record: ResearchSessionRecord = { schema_version: "1", id: store.newId(), revision: 1, created_at: now, updated_at: now, compatibility: "a-different-provider-is-safe-for-read-only-planning", request: result.request, result };
  await store.withLock(record.id, () => store.save(record, null)); return record;
}

test("keeps the selected scope, actual language coverage and original settings without mutating or fetching", async () => {
  const raw = video(); raw.request.language = "zh-CN"; raw.request.sourceQuality = { profile: "custom", resolution: "1080p", fps: 60, onUnavailable: "warn" };
  const before = structuredClone(raw), originalFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("Planning must not fetch"); }) as typeof fetch;
  try {
    const [material] = await run([{ kind: "video", result: raw }]);
    assert.equal(material.eligible, true); assert.equal(material.duration_seconds, 120);
    assert.deepEqual(material.requested_window, { start_seconds: 0, end_seconds: 60 });
    assert.deepEqual(material.language_windows, [{ start_seconds: 0, end_seconds: 15 }]);
    assert.equal(material.language, "zh-CN"); assert.deepEqual(material.source_quality, { profile: "custom", resolution: "1080p", fps: 60, on_unavailable: "warn" });
    assert.match(material.url!, /\?p=17$/); assert.equal(material.source_status, "complete");
    assert.doesNotMatch(JSON.stringify(material), /OLD_FINAL_ANSWER|token=private/); assert.equal(fetches, 0); assert.deepEqual(raw, before);
  } finally { globalThis.fetch = originalFetch; }
});

test("an available caption query covers its requested scope despite normal silent cue gaps", async () => {
  const raw = video(); raw.capabilities.captions.status = "available";
  raw.evidence = [{ ...raw.evidence[0], kind: "caption", precision: "caption_cue", time_range: { start_seconds: 0, end_seconds: 5 } }, { ...raw.evidence[0], id: "caption:2", kind: "caption", precision: "caption_cue", time_range: { start_seconds: 50, end_seconds: 55 } }];
  const [material] = await run([{ kind: "video", result: raw }]);
  assert.equal(material.eligible, true); assert.deepEqual(material.language_windows, [{ start_seconds: 0, end_seconds: 60 }]);
  assert.ok(material.limitations.some((value) => /silence/.test(value)));
});

test("image OCR covers only its actual pages and body text never covers images", async () => {
  const raw = note(), [material] = await run([{ kind: "note", result: raw }]);
  assert.equal(material.eligible, true); assert.equal(material.original_mode, "multimodal");
  assert.deepEqual(material.requested_pages, { start_page: 1, end_page: 3 }); assert.deepEqual(material.language_pages, [1, 3]); assert.deepEqual(material.visual_pages, []);
  raw.evidence = [raw.evidence[0]];
  assert.deepEqual((await run([{ kind: "note", result: raw }]))[0].language_pages, []);
});

test("complete same-question visual processing counts even with no relevant finding, but a changed question needs reinspection", async () => {
  const raw = video(); raw.request.mode = "vision"; raw.evidence = [{ ...raw.evidence[0], kind: "visual", content: undefined, time_range: { start_seconds: 0, end_seconds: 60 } }];
  const [same] = await run([{ kind: "video", result: raw }]);
  assert.equal(same.eligible, true); assert.equal(same.evidence_ids.length, 0); assert.deepEqual(same.visual_windows, [{ start_seconds: 0, end_seconds: 60 }]);
  const [changed] = await run([{ kind: "video", result: raw }], "Identify a different visual feature");
  assert.equal(changed.eligible, true); assert.equal(changed.visual_question_changed, true); assert.deepEqual(changed.visual_windows, []);
  const images = note(); images.evidence = [{ ...images.evidence[1], kind: "image_visual", content: undefined }];
  const [sameNote] = await run([{ kind: "note", result: images }]); assert.deepEqual(sameNote.visual_pages, [1]);
  const [changedNote] = await run([{ kind: "note", result: images }], "A new image question"); assert.equal(changedNote.eligible, true); assert.deepEqual(changedNote.visual_pages, []);
});

test("unavailable but structurally valid metadata remains eligible while invalid identity or budgets fail closed", async (t) => {
  const raw = video(); raw.status = "unavailable"; raw.evidence = [];
  const [empty] = await run([{ kind: "video", result: raw }]); assert.equal(empty.eligible, true); assert.equal(empty.source_status, "unavailable");
  const mutations: Array<[string, (r: ResearchResult) => void]> = [
    ["foreign evidence", (r) => { r.evidence[0].source.video_id = "BV1xx411c7mD"; }],
    ["wrong selected part", (r) => { r.evidence[0].source.url = r.evidence[0].source.url.replace("p=17", "p=18"); }],
    ["outside selected scope", (r) => { r.evidence[0].time_range!.end_seconds = 61; }],
    ["unbounded duration", (r) => { r.video!.durationSeconds = 31 * 24 * 60 * 60 + 1; }],
    ["invalid mode", (r) => { (r.request as unknown as Record<string, unknown>).mode = "text"; }],
    ["invalid language", (r) => { r.request.language = "x"; }],
    ["invalid quality", (r) => { r.request.sourceQuality = { profile: "custom", fps: 60 }; }],
    ["source evidence budget", (r) => { r.evidence = Array.from({ length: 81 }, (_, i) => ({ ...r.evidence[0], id: `asr:${i}` })); }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async () => {
    const bad = video(); mutate(bad); const [material] = await run([{ kind: "video", result: bad }]);
    assert.equal(material.eligible, false); assert.deepEqual(material.language_windows, []); assert.deepEqual(material.visual_windows, []); assert.equal(material.can_resume, false);
  });
  const images = note(); images.note!.imageCount = 10_001; assert.equal((await run([{ kind: "note", result: images }]))[0].eligible, false);
  images.note!.imageCount = 10_000; const [bounded] = await run([{ kind: "note", result: images }]); assert.equal(bounded.eligible, true); assert.equal(bounded.requested_pages!.end_page, 10_000); assert.equal(bounded.language_pages.length, 2);
});

test("canonical source keys deduplicate ranges and aliases while retaining selected Bilibili parts", async () => {
  const one = video(), two = video(), three = video();
  two.video!.id = `bv${BV.slice(2)}`; two.evidence[0].source.video_id = two.video!.id; two.request.startSeconds = 10; two.evidence[0].time_range = { start_seconds: 10, end_seconds: 15 };
  three.video!.partId = "another-cid"; three.video!.canonicalUrl = three.video!.canonicalUrl.replace("p=17", "p=18"); three.evidence[0].source.part_id = "another-cid"; three.evidence[0].source.url = three.video!.canonicalUrl;
  const materials = await run([one, two, three].map((result) => ({ kind: "video", result })));
  assert.ok(materials.every((m) => m.eligible)); assert.equal(materials[0].source_key, materials[1].source_key); assert.notEqual(materials[0].source_key, materials[2].source_key); assert.match(materials[2].url!, /\?p=18$/);
});

test("access classifications use fixed codes and relevant capability states, never freeform text or caption/comment auth", async () => {
  const code = video(); code.errors.push({ code: "HTTP_412", message: "Blocked", stage: "source", retryable: false });
  const text = video(); text.warnings.push("HTTP 412 blocked auth_required RATE_LIMITED"); text.capabilities.captions.status = "auth_required"; text.capabilities.comments.status = "auth_required";
  const auth = note(); auth.capabilities.images.status = "auth_required";
  const rate = note(); rate.errors.push({ code: "SEARCH_RATE_LIMITED", message: "Slow down", stage: "source", retryable: true });
  const wrapper: XiaohongshuResearchResult = { schema_version: "1.0", content_type: "image_note", status: "partial", result: note(), errors: [{ code: "SEARCH_BLOCKED", message: "Blocked", stage: "source", retryable: false }] };
  const result = await run([{ kind: "video", result: code }, { kind: "video", result: text }, { kind: "note", result: auth }, { kind: "note", result: rate }, { kind: "xiaohongshu", result: wrapper }]);
  assert.deepEqual(result.map((m) => m.access), ["blocked", "not_checked", "auth_required", "rate_limited", "blocked"]); assert.equal(result[4].source_status, "partial");
});

test("provider access errors cannot mark the original media source as restricted", async (t) => {
  const providerStages = ["analysis", "transcription", "synthesis", "vision", "ocr", "overview:1/overview_analysis", "detail:1/detail_transcription"];
  for (const stage of providerStages) await t.test(stage, async () => {
    const raw = video(); raw.status = "partial";
    raw.errors = ["ACCESS_BLOCKED", "AUTH_REQUIRED", "RATE_LIMITED"].map((code) => ({ code, stage, message: "Provider rejected the request", retryable: false }));
    const [material] = await run([{ kind: "video", result: raw }]);
    assert.equal(material.eligible, true); assert.equal(material.access, "not_checked"); assert.deepEqual(material.language_windows, [{ start_seconds: 0, end_seconds: 15 }]);
    assert.deepEqual(material.errors.filter((e) => e.message === "Provider rejected the request").map((e) => e.code), ["ACCESS_BLOCKED", "AUTH_REQUIRED", "RATE_LIMITED"]);
  });
  const images = note(); images.errors = [{ code: "AUTH_REQUIRED", stage: "ocr", message: "OCR provider login failed", retryable: false }];
  const wrapper: XiaohongshuResearchResult = { schema_version: "1.0", content_type: "image_note", status: "partial", result: images, errors: images.errors };
  assert.equal((await run([{ kind: "xiaohongshu", result: wrapper }]))[0].access, "not_checked");
});

test("source and long-video acquisition restrictions keep their typed access states", async (t) => {
  for (const stage of ["source", "resolve", "acquire", "overview:2/overview_acquire", "detail:1/detail_acquire"]) await t.test(stage, async () => {
    for (const [code, expected] of [["ACCESS_BLOCKED", "blocked"], ["AUTH_REQUIRED", "auth_required"], ["RATE_LIMITED", "rate_limited"]] as const) {
      const raw = video(); raw.errors = [{ code, stage, message: "Source rejected the request", retryable: false }];
      assert.equal((await run([{ kind: "video", result: raw }]))[0].access, expected);
    }
  });
});

test("untyped source failures preserve diagnostics without guessing rate limits from their text", async () => {
  const raw = note(); raw.status = "partial"; raw.capabilities.images.status = "error";
  raw.errors = [{ code: "UPSTREAM_ERROR", stage: "acquire", message: "Xiaohongshu returned HTTP 429.", retryable: true }];
  const [material] = await run([{ kind: "note", result: raw }]);
  assert.equal(material.eligible, true); assert.equal(material.access, "not_checked");
  assert.ok(material.errors.some((e) => e.code === "UPSTREAM_ERROR" && e.message === raw.errors[0].message));
  assert.ok(material.limitations.some((value) => /without a typed access restriction/.test(value)));
});

test("long-video coverage comes from complete validated segments even without findings", async () => {
  const raw = longVideo();
  raw.findings = [{ id: "failed-observation", statement: "A claim in a failed window", evidence_ids: [raw.evidence[1].id], verification: "unverified", limitations: [] }];
  const [material] = await run([{ kind: "video", result: raw }]);
  assert.equal(material.eligible, true); assert.deepEqual(material.visual_windows, [{ start_seconds: 0, end_seconds: 600 }]);
  assert.equal(material.can_resume, false); assert.equal(material.session_id, null);
  const complete = longVideo(true); complete.findings = [];
  const [done] = await run([{ kind: "video", result: complete }]);
  assert.equal(done.eligible, true); assert.deepEqual(done.visual_windows, complete.plan!.overview_windows);
  const [changed] = await run([{ kind: "video", result: complete }], "A changed visual question");
  assert.equal(changed.eligible, true); assert.deepEqual(changed.visual_windows, []); assert.equal(changed.visual_question_changed, true);
});

test("retained long-video ASR remains usable after a segment analysis failure", async () => {
  const raw = longVideo(); raw.request.mode = "language";
  raw.evidence = raw.evidence.map((item) => ({ ...item, kind: "asr", content: "Retained original source transcription" }));
  raw.segments = raw.segments.map((segment) => ({ ...segment, basis: "audio" }));
  raw.errors = [{ code: "AUTH_REQUIRED", stage: "overview:2/overview_analysis", message: "Text provider authentication failed", retryable: false }];
  const [material] = await run([{ kind: "video", result: raw }]);
  assert.equal(material.eligible, true); assert.equal(material.access, "not_checked");
  assert.deepEqual(material.language_windows, raw.plan!.overview_windows); assert.deepEqual(material.visual_windows, []);
});

test("only actual loaded, same-question unfinished sessions can resume, using one local snapshot per id", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-followup-materials-")), oldDirectory = process.env.CATALYST_SESSION_DIR;
  const originalLoad = ResearchSessionStore.prototype.load;
  try {
    const store = new ResearchSessionStore(directory), saved = await save(store, longVideo()), completed = await save(store, longVideo(true));
    process.env.CATALYST_SESSION_DIR = directory; let loads = 0;
    ResearchSessionStore.prototype.load = async function(id) { loads++; return originalLoad.call(this, id); };
    const [first, alias] = await run([{ kind: "session", session_id: saved.id }, { kind: "session", session_id: saved.id }]);
    assert.equal(loads, 1); assert.equal(first.eligible, true); assert.equal(first.can_resume, true); assert.equal(first.session_id, saved.id); assert.equal(first.resume_window_seconds, 600); assert.deepEqual(first.visual_windows, [{ start_seconds: 0, end_seconds: 600 }]); assert.equal(alias.can_resume, true);
    const [newQuestion] = await run([{ kind: "session", session_id: saved.id }], "Inspect a different visual question"); assert.equal(newQuestion.eligible, true); assert.equal(newQuestion.can_resume, false); assert.deepEqual(newQuestion.visual_windows, []);
    const [done] = await run([{ kind: "session", session_id: completed.id }]); assert.equal(done.can_resume, false);
    const inline = longVideo(); inline.session = { id: saved.id, revision: 1, created_at: saved.created_at, updated_at: saved.updated_at, reused_segments: 0, processed_segments: 1 };
    const [forged] = await run([{ kind: "video", result: inline }]); assert.equal(forged.eligible, true); assert.equal(forged.session_id, null); assert.equal(forged.can_resume, false);
    const path = join(directory, `${saved.id}.json`), corrupt = JSON.parse(await fs.readFile(path, "utf8")); corrupt.request.question = "A mismatched record question"; await fs.writeFile(path, JSON.stringify(corrupt));
    const [mismatch] = await run([{ kind: "session", session_id: saved.id }]); assert.equal(mismatch.eligible, false); assert.ok(mismatch.errors.some((e) => /does not match/.test(e.message)));
    const [missing] = await run([{ kind: "session", session_id: store.newId() }]); assert.equal(missing.eligible, false); assert.ok(missing.errors.some((e) => e.code === "SESSION_NOT_FOUND"));
  } finally {
    ResearchSessionStore.prototype.load = originalLoad;
    if (oldDirectory === undefined) delete process.env.CATALYST_SESSION_DIR; else process.env.CATALYST_SESSION_DIR = oldDirectory;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("saved plan mismatch, missing completed references and excessive arrays fail closed", async (t) => {
  const mutations: Array<[string, (r: LongVideoResult) => void]> = [
    ["request and plan mismatch", (r) => { r.plan!.requested_window.end_seconds = 1199; }],
    ["forged overview", (r) => { r.plan!.overview_windows[0].end_seconds = 599; }],
    ["missing completed reference", (r) => { r.segments[0].evidence_ids = ["overview:1:missing"]; }],
    ["empty completed report", (r) => { r.segments[0].analysis = ""; }],
    ["unbounded segment array", (r) => { r.segments = Array.from({ length: 29 }, () => r.segments[0]); }],
    ["invalid download budget", (r) => { (r.request as LongVideoRequest).maxDownloadMB = 1; r.plan!.max_download_bytes = 1024 * 1024; }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async () => { const bad = longVideo(); mutate(bad); const [material] = await run([{ kind: "video", result: bad }]); assert.equal(material.eligible, false); assert.deepEqual(material.visual_windows, []); });
});

test("cancellation and deadlines stop planning before material work", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(preparePlanningMaterials([{ kind: "session", session_id: "invalid" }], QUESTION, { signal: controller.signal, deadlineMs: Date.now() + 1000 }), { name: "AbortError" });
  await assert.rejects(preparePlanningMaterials([{ kind: "video", result: video() }], QUESTION, { signal: new AbortController().signal, deadlineMs: Date.now() - 1 }), { name: "TimeoutError" });
});
