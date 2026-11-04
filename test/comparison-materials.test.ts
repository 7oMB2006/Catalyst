import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Evidence, ExecutionContext, ResearchResult } from "../src/contracts.js";
import type { NoteResearchResult, XiaohongshuResearchResult } from "../src/note-contracts.js";
import type { ComparisonInput } from "../src/comparison-contracts.js";
import { prepareComparisonMaterials } from "../src/comparison-materials.js";
import { startLongVideoResearch } from "../src/research-sessions.js";
import { ResearchSessionStore } from "../src/research-session-store.js";

const QUESTION = "Compare the stated attention mechanisms";
const BV = "BV1DTxXzUEvW", CID = "38253823575", NOTE = "6aaaa3300000000025035966";
const context = (): ExecutionContext => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
function video(id = BV, part = "17", cid = CID): ResearchResult {
  const url = `https://www.bilibili.com/video/${id}/?p=${part}`;
  const evidence: Evidence = { id: "asr:1", kind: "asr", source: { platform: "bilibili", video_id: id, part_id: cid, url, origin: "fixture_asr" }, time_range: { start_seconds: 10, end_seconds: 20 }, time_basis: "source", precision: "requested_window", content: "Attention uses queries, keys and values.", limitations: ["Generated transcript, not independently verified."] };
  return {
    schema_version: "1.0", status: "complete", video: { platform: "bilibili", id, partId: cid, sourceUrl: `${url}&token=private-access`, canonicalUrl: url, title: "Attention course", durationSeconds: 120 },
    request: { url, question: "Original video question", mode: "language", startSeconds: 10, endSeconds: 20 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [evidence], findings: [], analysis: "OLD_FINAL_MUST_NOT_BE_USED", warnings: [], errors: [],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
function note(): NoteResearchResult {
  const url = `https://www.xiaohongshu.com/explore/${NOTE}`;
  return {
    schema_version: "1.0", status: "complete", note: { platform: "xiaohongshu", id: NOTE, sourceUrl: `${url}?xsec_token=private-note-access`, canonicalUrl: url, title: "Attention diagrams", description: "Note body", contentType: "image_note", imageCount: 3 },
    request: { url, question: "Original note question", mode: "combined" },
    capabilities: { body: { status: "available" }, images: { status: "available" }, ocr: { status: "available" }, comments: { status: "unsupported" } },
    evidence: [
      { id: "note:body", kind: "note_text", source: { platform: "xiaohongshu", note_id: NOTE, url, origin: "platform_note_body" }, page: null, content: "The author describes attention.", limitations: [] },
      { id: "asr:1", kind: "image_text", source: { platform: "xiaohongshu", note_id: NOTE, url, origin: "fixture_ocr" }, page: 2, content: "The diagram labels Query, Key and Value.", limitations: ["OCR may contain errors."] },
    ], findings: [], analysis: "OLD_FINAL_MUST_NOT_BE_USED", warnings: [], errors: [],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
const run = (inputs: ComparisonInput[], question = QUESTION) => prepareComparisonMaterials(inputs, question, context());

test("raw video and note text retain time/page locators in distinct namespaces without old answers", async () => {
  const first = video(), second = note(), before = structuredClone([first, second]);
  const result = await run([{ kind: "video", result: first }, { kind: "note", result: second }]);
  assert.deepEqual(result.materials.map((m) => m.status), ["ready", "ready"]);
  assert.equal(result.evidence.length, 3); assert.equal(new Set(result.evidence.map((e) => e.id)).size, 3);
  const transcript = result.evidence.find((e) => e.kind === "asr")!, ocr = result.evidence.find((e) => e.kind === "image_text")!;
  assert.equal(transcript.original_id, ocr.original_id); assert.notEqual(transcript.id, ocr.id);
  assert.deepEqual(transcript.locator.time_range, { start_seconds: 10, end_seconds: 20 }); assert.equal(transcript.locator.part_id, CID);
  assert.equal(ocr.locator.page, 2); assert.equal(ocr.locator.time_range, null);
  assert.ok(result.evidence.every((e) => e.basis === "source_text"));
  assert.doesNotMatch(JSON.stringify(result), /OLD_FINAL_MUST_NOT_BE_USED|private-access|private-note-access/);
  assert.deepEqual([first, second], before);
});

test("same-question cited visual findings are labelled derived while visual content is never treated as raw text", async () => {
  const first = video(); first.request.question = QUESTION; first.request.mode = "multimodal";
  first.evidence.push({ ...first.evidence[0], id: "visual:1", kind: "multimodal", content: "RAW_VISUAL_CONTENT_MUST_NOT_BE_USED", data: { channels: ["video", "audio"] } });
  first.findings = [{ id: "finding:1", statement: "The visible attention matrix is rectangular.", evidence_ids: ["visual:1", "asr:1"], verification: "unverified", limitations: ["Small text remains uncertain."] }];
  const second = note(); second.request.question = QUESTION;
  second.evidence = [{ ...second.evidence[1], id: "image:2:visual", kind: "image_visual", content: "RAW_VISUAL_CONTENT_MUST_NOT_BE_USED" }];
  second.findings = [{ id: "finding:1", statement: "The image shows query and key arrows.", evidence_ids: ["image:2:visual"], verification: "unverified", limitations: [] }];
  const result = await run([{ kind: "video", result: first }, { kind: "note", result: second }]);
  const derived = result.evidence.filter((e) => e.basis === "derived_observation");
  assert.equal(derived.length, 2); assert.ok(derived.every((e) => e.limitations.some((l) => /unverified derived/i.test(l))));
  assert.equal(derived[0].original_id, "visual:1"); assert.equal(derived[1].locator.page, 2);
  assert.doesNotMatch(JSON.stringify(result), /RAW_VISUAL_CONTENT_MUST_NOT_BE_USED|OLD_FINAL_MUST_NOT_BE_USED/);
});

test("new questions exclude old visual findings and preserve only reusable language evidence", async () => {
  const first = video(); first.request.mode = "multimodal";
  first.evidence.push({ ...first.evidence[0], id: "visual:1", kind: "visual" });
  first.findings = [{ id: "finding:1", statement: "OLD_VISUAL_CLAIM", evidence_ids: ["visual:1"], verification: "unverified", limitations: [] }];
  const result = await run([{ kind: "video", result: first }]);
  assert.equal(result.materials[0].status, "partial"); assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].basis, "source_text"); assert.doesNotMatch(JSON.stringify(result), /OLD_VISUAL_CLAIM/);
  assert.ok(result.materials[0].limitations.some((l) => /question changed/i.test(l)));
});

test("findings supported partly by metadata or comments do not enter derived observations", async () => {
  const first = video(); first.request.question = QUESTION; first.request.mode = "multimodal";
  first.evidence.push({ ...first.evidence[0], id: "visual:1", kind: "visual" }, { ...first.evidence[0], id: "metadata:1", kind: "metadata", time_range: null, time_basis: "none" });
  first.findings = [{ id: "finding:1", statement: "MIXED_METADATA_CLAIM", evidence_ids: ["visual:1", "metadata:1"], verification: "unverified", limitations: [] }];
  const result = await run([{ kind: "video", result: first }]);
  assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].kind, "asr");
  assert.doesNotMatch(JSON.stringify(result), /MIXED_METADATA_CLAIM/);
});

test("same video parts share a dependence group but retain all complementary evidence", async () => {
  const result = await run([{ kind: "video", result: video() }, { kind: "video", result: video(BV, "18", "other-cid") }]);
  assert.equal(result.materials[1].duplicate_of, result.materials[0].id);
  assert.equal(result.materials[0].source_group, result.materials[1].source_group);
  assert.notEqual(result.materials[0].source_key, result.materials[1].source_key);
  assert.equal(result.evidence.length, 2); assert.notEqual(result.evidence[0].id, result.evidence[1].id);
});

test("joint visual findings spanning several windows or pages are not assigned to a single locator", async (t) => {
  await t.test("two video windows", async () => {
    const first = video(); first.request.question = QUESTION; first.request.mode = "multimodal";
    first.evidence.push({ ...first.evidence[0], id: "visual:1", kind: "visual", time_range: { start_seconds: 10, end_seconds: 12 } }, { ...first.evidence[0], id: "visual:2", kind: "visual", time_range: { start_seconds: 15, end_seconds: 20 } });
    first.findings = [{ id: "finding:1", statement: "JOINT_VISUAL_CLAIM", evidence_ids: ["visual:1", "visual:2"], verification: "unverified", limitations: [] }];
    const result = await run([{ kind: "video", result: first }]);
    assert.equal(result.materials[0].status, "partial"); assert.equal(result.evidence.length, 1);
    assert.ok(result.materials[0].limitations.some((l) => /joined several/i.test(l)));
    assert.doesNotMatch(JSON.stringify(result), /JOINT_VISUAL_CLAIM/);
  });
  await t.test("two image pages", async () => {
    const first = note(); first.request.question = QUESTION;
    first.evidence.push({ ...first.evidence[1], id: "image:2:visual", kind: "image_visual", page: 2 }, { ...first.evidence[1], id: "image:3:visual", kind: "image_visual", page: 3 });
    first.findings = [{ id: "finding:1", statement: "JOINT_PAGE_CLAIM", evidence_ids: ["image:2:visual", "image:3:visual"], verification: "unverified", limitations: [] }];
    const result = await run([{ kind: "note", result: first }]);
    assert.equal(result.materials[0].status, "partial"); assert.equal(result.evidence.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /JOINT_PAGE_CLAIM/);
  });
});

test("source aliases and Xiaohongshu video/image channels share source groups without losing evidence", async (t) => {
  await t.test("BV prefix alias", async () => {
    const one = video(), two = video();
    two.video!.id = `bv${BV.slice(2)}`; two.evidence[0].source.video_id = two.video!.id;
    const result = await run([{ kind: "video", result: one }, { kind: "video", result: two }]);
    assert.ok(result.materials.every((m) => m.status === "ready"));
    assert.equal(result.materials[1].duplicate_of, result.materials[0].id); assert.equal(result.evidence.length, 2);
  });
  await t.test("uppercase note ID", async () => {
    const one = note(), two = note(); two.note!.id = NOTE.toUpperCase();
    two.evidence.forEach((e) => { e.source.note_id = NOTE.toUpperCase(); });
    const result = await run([{ kind: "note", result: one }, { kind: "note", result: two }]);
    assert.ok(result.materials.every((m) => m.status === "ready"));
    assert.equal(result.materials[1].duplicate_of, result.materials[0].id); assert.equal(result.evidence.length, 4);
  });
  await t.test("video and image channels of the same note", async () => {
    const one = video(), two = note(), url = two.note!.canonicalUrl;
    one.video = { ...one.video!, platform: "xiaohongshu", id: NOTE.toUpperCase(), partId: undefined, canonicalUrl: url, sourceUrl: url };
    one.evidence[0].source = { platform: "xiaohongshu", video_id: NOTE.toUpperCase(), url, origin: "fixture_asr" };
    const result = await run([{ kind: "video", result: one }, { kind: "note", result: two }]);
    assert.ok(result.materials.every((m) => m.status === "ready"));
    assert.equal(result.materials[1].duplicate_of, result.materials[0].id); assert.equal(result.evidence.length, 3);
  });
});

test("unavailable or corrupt material does not discard another material's valid text", async (t) => {
  const mutations: Array<[string, (r: ResearchResult) => void]> = [
    ["foreign video", (r) => { r.evidence[0].source.video_id = "BV1xx411c7mD"; }],
    ["invalid video prefix", (r) => { r.video!.id = `XX${BV.slice(2)}`; r.evidence[0].source.video_id = r.video!.id; }],
    ["foreign part", (r) => { r.evidence[0].source.part_id = "wrong-cid"; }],
    ["wrong canonical part", (r) => { r.evidence[0].source.url = r.evidence[0].source.url.replace("p=17", "p=18"); }],
    ["out of source", (r) => { r.evidence[0].time_range!.end_seconds = 121; }],
    ["out of selected window", (r) => { r.evidence[0].time_range = { start_seconds: 0, end_seconds: 5 }; }],
    ["duplicate evidence", (r) => { r.evidence.push(structuredClone(r.evidence[0])); }],
    ["missing finding reference", (r) => { r.findings.push({ id: "finding:1", statement: "Invalid", evidence_ids: ["missing"], verification: "unverified", limitations: [] }); }],
    ["invalid old question", (r) => { (r.request as unknown as Record<string, unknown>).question = 123; }],
    ["invalid old mode", (r) => { (r.request as unknown as Record<string, unknown>).mode = "unknown"; }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async () => {
    const bad = video(); mutate(bad);
    const result = await run([{ kind: "video", result: bad }, { kind: "note", result: note() }]);
    assert.equal(result.materials[0].status, "unavailable"); assert.equal(result.materials[1].status, "ready");
    assert.ok(result.materials[0].errors.length); assert.ok(result.evidence.every((e) => e.material_id === result.materials[1].id));
  });
});

test("caption cue overlap is retained while unrelated time windows are rejected", async () => {
  const first = video(); first.evidence[0].kind = "caption"; first.evidence[0].time_range = { start_seconds: 8, end_seconds: 12 };
  const result = await run([{ kind: "video", result: first }]);
  assert.equal(result.materials[0].status, "ready"); assert.deepEqual(result.evidence[0].locator.time_range, { start_seconds: 8, end_seconds: 12 });
});

test("page scope rejects foreign pages and scoped note bodies", async () => {
  const badPage = note(); badPage.evidence[1].page = 4;
  const scopedBody = note(); scopedBody.request.startPage = 2; scopedBody.request.endPage = 2;
  const result = await run([{ kind: "note", result: badPage }, { kind: "note", result: scopedBody }]);
  assert.ok(result.materials.every((m) => m.status === "unavailable")); assert.deepEqual(result.evidence, []);
});

test("empty raw text, old visual-only observations and discovery candidates cannot masquerade as reusable evidence", async () => {
  const empty = video(); empty.evidence[0].content = " \n ";
  const onlyVisual = note(); onlyVisual.evidence = [{ ...onlyVisual.evidence[1], kind: "image_visual" }];
  const fake = { kind: "video", result: { platform: "bilibili", title: "Search candidate", content_status: "not_read" } } as unknown as ComparisonInput;
  const result = await run([{ kind: "video", result: empty }, { kind: "note", result: onlyVisual }, fake]);
  assert.ok(result.materials.every((m) => m.status === "unavailable")); assert.deepEqual(result.evidence, []);
});

test("budgets reject whole offending materials without truncating evidence", async () => {
  const tooLong = video(); tooLong.evidence[0].content = "x".repeat(32_001);
  const tooMany = video(); tooMany.evidence = Array.from({ length: 81 }, (_, i) => ({ ...tooMany.evidence[0], id: `asr:${i}` }));
  const result = await run([{ kind: "video", result: tooLong }, { kind: "video", result: tooMany }, { kind: "note", result: note() }]);
  assert.ok(result.materials.slice(0, 2).every((m) => m.errors.some((e) => e.code === "MATERIAL_BUDGET_EXCEEDED")));
  assert.equal(result.materials[2].status, "ready"); assert.equal(result.evidence.length, 2);
  const sources = [BV, "BV1xx411c7mD", "BV1Q541167Qg"].map((id) => {
    const r = video(id); r.evidence = Array.from({ length: 80 }, (_, i) => ({ ...r.evidence[0], id: `asr:${i}` })); return { kind: "video", result: r } as const;
  });
  const bounded = await run(sources);
  assert.equal(bounded.evidence.length, 160); assert.equal(bounded.materials[2].status, "unavailable");
  assert.ok(bounded.materials[2].errors.some((e) => e.code === "MATERIAL_BUDGET_EXCEEDED"));
});

test("partial input and Xiaohongshu wrappers preserve status, errors and source citations", async () => {
  const inner = note(); inner.status = "partial"; inner.errors.push({ code: "OCR_INCOMPLETE", stage: "ocr", message: "One page was unavailable", retryable: true });
  const wrapper: XiaohongshuResearchResult = { schema_version: "1.0", content_type: "image_note", status: "partial", result: inner, errors: [] };
  const result = await run([{ kind: "xiaohongshu", result: wrapper }]);
  assert.equal(result.materials[0].status, "partial"); assert.equal(result.evidence.length, 2);
  assert.ok(result.materials[0].errors.some((e) => e.code === "OCR_INCOMPLETE"));
});

test("provided signed URLs and configured secrets never appear in prepared material", async () => {
  const key = "CATALYST_COMPARISON_FIXTURE_SECRET", old = process.env[key], secret = "fixture-private-comparison-secret";
  process.env[key] = secret;
  try {
    const first = video(); first.video!.canonicalUrl += `&token=${secret}`; first.evidence[0].source.url += `&token=${secret}`;
    first.evidence[0].content += ` ${secret} https://cdn.example.test/file?signature=private-signature`;
    const result = await run([{ kind: "video", result: first, label: secret }]);
    assert.equal(result.materials[0].status, "ready");
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-comparison-secret|private-signature|token=/);
    assert.match(result.evidence[0].locator.url, /\?p=17$/);
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});

test("saved long-video sessions supply raw material without provider compatibility or source calls", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-comparison-materials-")), oldDirectory = process.env.CATALYST_SESSION_DIR;
  try {
    const store = new ResearchSessionStore(directory), request = video().request;
    const result = await startLongVideoResearch({ ...request, startSeconds: 0, endSeconds: 120, segmentSeconds: 120, maxDetailWindows: 0 }, { store, dependencies: {
      resolve: async () => ({ video: video().video!, captions: { status: "available", kind: "manual", cues: [{ start: 0, end: 120, content: "Saved language evidence for comparison." }] }, capabilities: video().capabilities, comments: { status: "disabled", items: [] }, warnings: [] }),
      analyzeText: async (prompt) => JSON.stringify({ analysis: "Saved report", findings: [{ statement: "Saved source statement", evidence_ids: [prompt.includes("SYNTHESIS:") ? "overview:1:source" : "overview:1:source"] }], relevance_score: 0 }),
    } });
    assert.equal(result.status, "complete"); assert.ok(result.session);
    process.env.CATALYST_SESSION_DIR = directory;
    const prepared = await run([{ kind: "session", session_id: result.session.id }]);
    assert.equal(prepared.materials[0].status, "ready"); assert.match(prepared.evidence[0].content, /Saved language evidence/);
    const path = join(directory, `${result.session.id}.json`), saved = JSON.parse(await fs.readFile(path, "utf8"));
    saved.request.question = "A mismatched stored request";
    await fs.writeFile(path, JSON.stringify(saved));
    const corrupt = await run([{ kind: "session", session_id: result.session.id }, { kind: "note", result: note() }]);
    assert.equal(corrupt.materials[0].status, "unavailable"); assert.equal(corrupt.materials[1].status, "ready");
    assert.ok(corrupt.materials[0].errors.some((e) => /request does not match/.test(e.message)));
  } finally {
    if (oldDirectory === undefined) delete process.env.CATALYST_SESSION_DIR; else process.env.CATALYST_SESSION_DIR = oldDirectory;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pre-cancelled preparation stops before session disk reads or material handling", async () => {
  const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(prepareComparisonMaterials([{ kind: "session", session_id: "missing" }], QUESTION, { signal: controller.signal, deadlineMs: Date.now() + 1000 }), /cancelled/i);
});
