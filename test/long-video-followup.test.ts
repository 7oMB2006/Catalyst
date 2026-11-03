import assert from "node:assert/strict";
import test from "node:test";
import type { Evidence, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoRequest, LongVideoResult } from "../src/long-video-contracts.js";
import { researchLongVideo } from "../src/long-video.js";

const URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const PARENT_ID = "57e4e2e7-483a-44de-a031-c29f8f553974";
const PARENT_REVISION = 7;
const OLD_QUESTION = "OLD_QUESTION: 这一节课介绍了哪些机制？";
const NEW_QUESTION = "NEW_QUESTION: 第二种机制的公式和计算量如何解释？";
const OLD_REPORT = "OLD_QUESTION_CONCLUSION_MUST_NOT_ENTER_NEW_PROMPTS";
const REQUEST: LongVideoRequest = { url: URL, question: OLD_QUESTION, mode: "multimodal", language: "zh", maxDetailWindows: 0 };
const FOLLOWUP: LongVideoRequest = { ...REQUEST, question: NEW_QUESTION, mode: "language", maxDetailWindows: 0 };

function source(duration = 1200): SourceContext {
  return {
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: URL, canonicalUrl: URL, title: "Attention course part 17", durationSeconds: duration, metadata: { part: 17 } },
    captions: { status: "auth_required", kind: "unknown", cues: [] },
    comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "auth_required" }, media: { status: "not_requested" }, comments: { status: "disabled" } },
    warnings: [],
  };
}
function primaryIn(prompt: string): Evidence[] {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const offset = prompt.lastIndexOf(marker);
  assert.notEqual(offset, -1, "each analysis receives explicit primary evidence");
  return JSON.parse(prompt.slice(offset + marker.length));
}
function answer(prompt: string, old = false): string {
  const item = primaryIn(prompt).find((entry) => entry.kind !== "metadata");
  assert.ok(item);
  const secondWindow = item.time_range?.start_seconds === 600;
  return JSON.stringify({
    analysis: old ? OLD_REPORT : `NEW_QUESTION_REPORT from ${item.id}; visible formula details require visual evidence.`,
    findings: [{ statement: old ? OLD_REPORT : `NEW_QUESTION_FINDING from ${item.id}.`, evidence_ids: [item.id], limitations: ["Fixture interpretation, not verified accuracy."] }],
    relevance_score: old ? (secondWindow ? 0 : 3) : (secondWindow ? 3 : 0),
    focus_offset_seconds: old ? 60 : 450,
  });
}
function fixture(selected = source(), label = "new") {
  const calls = {
    resolves: 0, acquired: [] as Array<[number | undefined, number | undefined]>,
    transcribed: [] as string[], media: [] as Array<{ prompt: string; detail: "low" | "default" }>,
    text: [] as string[], created: [] as string[], disposed: [] as string[],
  };
  const owned = (path: string) => {
    calls.created.push(path);
    return { path, dispose: async () => { assert.ok(!calls.disposed.includes(path)); calls.disposed.push(path); } };
  };
  const deps: LongVideoDependencies = {
    resolve: async () => { calls.resolves++; return structuredClone(selected); },
    acquireWindow: async (_video, request) => {
      calls.acquired.push([request.startSeconds, request.endSeconds]);
      return { ...owned(`/fixture/${label}-${request.startSeconds}-${request.endSeconds}.mp4`), bytes: 1024, width: 854, height: 480, fps: 30 };
    },
    prepareWindow: async (path, _mode, detail) => owned(`${path}.${detail}.prepared.mp4`),
    transcribe: async (path) => { calls.transcribed.push(path); return `RAW_LANGUAGE_EVIDENCE from ${path}: Attention compares query and key before weighting values.`; },
    analyzeMedia: async (_path, prompt, detail) => { calls.media.push({ prompt, detail }); return answer(prompt, label === "old"); },
    analyzeText: async (prompt) => { calls.text.push(prompt); return answer(prompt, label === "old"); },
  };
  return { deps, calls };
}
function reuse(result: LongVideoResult) { return { result, parentSessionId: PARENT_ID, parentRevision: PARENT_REVISION }; }
async function parent(selected = source(), request = REQUEST) {
  const initial = fixture(selected, "old");
  const result = await researchLongVideo(request, initial.deps);
  assert.equal(result.status, "complete");
  return result;
}
function assertNoMedia(calls: ReturnType<typeof fixture>["calls"]) {
  assert.deepEqual(calls.acquired, []); assert.deepEqual(calls.transcribed, []); assert.deepEqual(calls.media, []);
  assert.equal(calls.created.length, 0);
}
function assertFreshPrompts(calls: ReturnType<typeof fixture>["calls"]) {
  for (const prompt of [...calls.text, ...calls.media.map((call) => call.prompt)]) {
    assert.ok(prompt.includes(NEW_QUESTION));
    assert.ok(!prompt.includes(OLD_QUESTION), "old question is not an instruction to a new analysis");
    assert.ok(!prompt.includes(OLD_REPORT), "old reports and findings are question-specific derived data");
  }
}
function assertReferences(result: LongVideoResult) {
  const ids = new Set(result.evidence.map((item) => item.id));
  assert.equal(ids.size, result.evidence.length);
  assert.ok(result.findings.length > 0);
  for (const finding of result.findings) assert.ok(finding.evidence_ids.every((id) => ids.has(id)));
  for (const segment of result.segments.filter((item) => item.status === "complete")) {
    assert.ok(segment.analysis?.trim());
    assert.ok(segment.evidence_ids.length > 0 && segment.evidence_ids.every((id) => ids.has(id)));
  }
}

test("a new language question reuses only raw ASR and rebuilds every report without media work or parent mutation", async () => {
  const previous = await parent(), before = structuredClone(previous), next = fixture();
  const result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(result.status, "complete"); assert.equal(next.calls.resolves, 1);
  assertNoMedia(next.calls); assert.equal(next.calls.text.length, 3, "two new-question overviews and one synthesis");
  assertFreshPrompts(next.calls);
  assert.deepEqual(result.follow_up, { parent_session_id: PARENT_ID, parent_revision: PARENT_REVISION, reused_evidence_ids: ["overview:1:asr", "overview:2:asr"] });
  assert.ok(result.evidence.filter((item) => item.kind !== "metadata").every((item) => item.kind === "asr"));
  for (const id of result.follow_up!.reused_evidence_ids) {
    assert.equal(result.evidence.find((item) => item.id === id)?.content, previous.evidence.find((item) => item.id === id)?.content);
  }
  assert.ok(result.segments.every((item) => item.basis === "audio" && item.analysis?.includes("NEW_QUESTION_REPORT")));
  assert.deepEqual(result.coverage.overview, result.plan?.overview_windows);
  assert.equal(result.processing.download_bytes, 0); assert.deepEqual(previous, before);
  assertReferences(result);
});

test("a caption-based parent supplies saved text even when the fresh source no longer offers captions", async () => {
  const captionSource = source();
  captionSource.captions = { status: "available", kind: "manual", language: "zh", cues: [
    { start: 0, end: 580, content: "SAVED_CAPTION_ONE: query key attention." },
    { start: 610, end: 1190, content: "SAVED_CAPTION_TWO: sparse attention reduces computation." },
  ] };
  captionSource.capabilities.captions = { status: "available" };
  const previous = await parent(captionSource, { ...REQUEST, mode: "language" }), next = fixture();
  const result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(result.status, "complete"); assertNoMedia(next.calls); assertFreshPrompts(next.calls);
  assert.equal(next.calls.text.length, 3);
  assert.ok(result.segments.every((item) => item.basis === "captions"));
  assert.ok(result.evidence.filter((item) => item.kind !== "metadata").every((item) => item.kind === "caption"));
  assert.ok(next.calls.text.some((prompt) => prompt.includes("SAVED_CAPTION_ONE")));
  assert.ok(next.calls.text.some((prompt) => prompt.includes("SAVED_CAPTION_TWO")));
  assertReferences(result);
});

test("a multimodal follow-up selects a new detail from fresh language relevance and acquires only that window", async () => {
  const previous = await parent(), next = fixture();
  const request: LongVideoRequest = { ...FOLLOWUP, mode: "multimodal", maxDetailWindows: 1, detailWindowSeconds: 120 };
  const result = await researchLongVideo(request, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(result.status, "complete");
  assert.deepEqual(next.calls.acquired, [[990, 1110]], "the old first-window relevance/focus must not drive new detail selection");
  assert.equal(next.calls.transcribed.length, 1); assert.equal(next.calls.media.length, 1); assert.equal(next.calls.media[0].detail, "default");
  assert.equal(next.calls.text.length, 3); assertFreshPrompts(next.calls);
  const overview = result.segments.filter((item) => item.phase === "overview"), detail = result.segments.filter((item) => item.phase === "detail");
  assert.ok(overview.every((item) => item.basis === "audio" && item.evidence_ids.every((id) => id.endsWith(":asr"))));
  assert.equal(detail.length, 1); assert.equal(detail[0].basis, "audio_video");
  assert.deepEqual(result.coverage.detail, [{ start_seconds: 990, end_seconds: 1110 }]);
  assert.ok(!result.evidence.some((item) => item.kind === "multimodal" && item.id.startsWith("overview:")));
  assert.match(result.coverage.limitations.join(" "), /language|transcript/i);
  assert.equal(result.processing.download_bytes, 1024);
  assert.deepEqual([...next.calls.created].sort(), [...next.calls.disposed].sort());
  assertReferences(result);
});

test("a failed parent window's leftover ASR is not reused or silently replaced with a full media acquisition", async () => {
  const first = fixture(source(), "old"), media = first.deps.analyzeMedia;
  first.deps.analyzeMedia = async (...args) => {
    if (primaryIn(args[1])[0].id.startsWith("overview:2:")) throw Object.assign(new Error("Fixture report failure"), { code: "UPSTREAM_ERROR" });
    return media(...args);
  };
  const previous = await researchLongVideo(REQUEST, first.deps);
  assert.equal(previous.segments[1].status, "failed");
  assert.ok(previous.evidence.some((item) => item.id === "overview:2:asr" && item.content));
  const next = fixture(), result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(result.status, "partial"); assertNoMedia(next.calls);
  assert.deepEqual(result.follow_up?.reused_evidence_ids, ["overview:1:asr"]);
  assert.deepEqual(result.coverage.overview, [{ start_seconds: 0, end_seconds: 600 }]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  assert.equal(result.segments[1].error, "MATERIAL_UNAVAILABLE");
  assert.ok(!result.evidence.some((item) => item.id === "overview:2:asr"));
  assertReferences(result);
});

test("a visual-only parent cannot supply language coverage or trigger a hidden full reanalysis", async () => {
  const previous = await parent(source(), { ...REQUEST, mode: "vision" }), next = fixture();
  const result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(result.status, "unavailable"); assertNoMedia(next.calls); assert.deepEqual(next.calls.text, []);
  assert.equal(result.coverage.overview_complete, false);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 0, end_seconds: 1200 }]);
  assert.ok(result.errors.some((item) => item.code === "MATERIAL_UNAVAILABLE"));
});

test("follow-up revalidates source and selected-part identity before any media or model work", async (t) => {
  const previous = await parent();
  const changes: Array<[string, (selected: SourceContext) => void]> = [
    ["platform", (selected) => { selected.video.platform = "youtube"; }],
    ["video", (selected) => { selected.video.id = "different-video"; }],
    ["part", (selected) => { selected.video.partId = "foreign-cid"; }],
    ["canonical URL", (selected) => { selected.video.canonicalUrl = URL.replace("p=17", "p=18"); }],
    ["duration", (selected) => { selected.video.durationSeconds = 1201; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const selected = source(); change(selected);
    const next = fixture(selected), result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { materialReuse: reuse(previous) });
    assert.ok(result.errors.some((item) => item.code === "SESSION_INCOMPATIBLE"));
    assertNoMedia(next.calls); assert.deepEqual(next.calls.text, []);
  });
});

test("malformed, foreign, empty and incorrectly timed parent language evidence never enters new-question analysis", async (t) => {
  const baseline = await parent();
  const corruptions: Array<[string, (saved: LongVideoResult) => void]> = [
    ["foreign part", (saved) => { saved.evidence.find((item) => item.kind === "asr")!.source.part_id = "foreign-part"; }],
    ["empty raw text", (saved) => { saved.evidence.find((item) => item.kind === "asr")!.content = "  \n "; }],
    ["oversized raw text", (saved) => { saved.evidence.find((item) => item.kind === "asr")!.content = "x".repeat(32_001); }],
    ["wrong evidence time", (saved) => { saved.evidence.find((item) => item.kind === "asr")!.time_range!.start_seconds = 30; }],
    ["duplicate ID", (saved) => { saved.evidence.push(structuredClone(saved.evidence.find((item) => item.kind === "asr")!)); }],
    ["missing reference", (saved) => { saved.segments[0].evidence_ids = ["overview:1:missing"]; }],
    ["empty completed report", (saved) => { saved.segments[0].analysis = "  "; }],
  ];
  for (const [name, corrupt] of corruptions) await t.test(name, async () => {
    const previous = structuredClone(baseline); corrupt(previous);
    const next = fixture(), result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { materialReuse: reuse(previous) });
    assert.ok(result.errors.some((item) => item.code === "SESSION_INCOMPATIBLE"));
    assertNoMedia(next.calls); assert.deepEqual(next.calls.text, []);
  });
});

test("the initial child checkpoint already contains every reusable raw window and resumes without the parent", async () => {
  const previous = await parent(), next = fixture(), controller = new AbortController();
  let saved: LongVideoResult | undefined;
  await researchLongVideo(FOLLOWUP, next.deps, controller.signal, {
    materialReuse: reuse(previous),
    onCheckpoint: async (result) => {
      if (!saved && result.plan) {
        saved = structuredClone(result);
        controller.abort(new DOMException("Stop immediately after the child is durable", "AbortError"));
      }
    },
  });
  assert.ok(saved); assert.ok(saved.segments.every((item) => item.status === "pending"));
  assert.deepEqual(saved.follow_up?.reused_evidence_ids, ["overview:1:asr", "overview:2:asr"]);
  for (const segment of saved.segments) {
    assert.equal(segment.evidence_ids.length, 1);
    assert.ok(saved.evidence.some((item) => item.id === segment.evidence_ids[0] && item.content?.includes("RAW_LANGUAGE_EVIDENCE")));
  }
  assertNoMedia(next.calls); assert.deepEqual(next.calls.text, []);
  const restarted = fixture(), result = await researchLongVideo(FOLLOWUP, restarted.deps, undefined, { previous: structuredClone(saved) });
  assert.equal(result.status, "complete"); assertNoMedia(restarted.calls); assert.equal(restarted.calls.text.length, 3);
  assert.deepEqual(result.follow_up, saved.follow_up); assertFreshPrompts(restarted.calls); assertReferences(result);
});

test("a child restart reuses its own completed new-question reports and analyzes only pending saved text", async () => {
  const previous = await parent(), next = fixture(), controller = new AbortController();
  let saved: LongVideoResult | undefined;
  await researchLongVideo(FOLLOWUP, next.deps, controller.signal, {
    materialReuse: reuse(previous),
    onCheckpoint: async (result) => {
      if (!saved && result.segments[0]?.status === "complete") {
        saved = structuredClone(result);
        controller.abort(new DOMException("Stop after one new-question overview", "AbortError"));
      }
    },
  });
  assert.ok(saved); assert.deepEqual(saved.segments.map((item) => item.status), ["complete", "pending"]);
  const restarted = fixture(), result = await researchLongVideo(FOLLOWUP, restarted.deps, undefined, { previous: structuredClone(saved) });
  assert.equal(result.status, "complete"); assertNoMedia(restarted.calls);
  assert.equal(restarted.calls.text.length, 2, "only the pending new-question overview and synthesis remain");
  assert.equal(primaryIn(restarted.calls.text[0])[0].id, "overview:2:asr");
  assert.equal(result.segments[0].analysis, saved.segments[0].analysis);
  assert.deepEqual(result.follow_up, saved.follow_up); assertFreshPrompts(restarted.calls); assertReferences(result);
});

test("multimodal child restart retains language-only overview and processes only its unfinished visual detail", async () => {
  const previous = await parent(), next = fixture();
  next.deps.analyzeMedia = async (_path, prompt, detail) => { next.calls.media.push({ prompt, detail }); throw Object.assign(new Error("Fixture visual provider failure"), { code: "UPSTREAM_ERROR" }); };
  const request: LongVideoRequest = { ...FOLLOWUP, mode: "multimodal", maxDetailWindows: 1, detailWindowSeconds: 120 };
  const saved = await researchLongVideo(request, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(saved.status, "partial");
  assert.deepEqual(saved.segments.map((item) => item.status), ["complete", "complete", "failed"]);
  const restarted = fixture(), result = await researchLongVideo(request, restarted.deps, undefined, { previous: structuredClone(saved) });
  assert.equal(result.status, "complete"); assert.deepEqual(restarted.calls.acquired, [[990, 1110]]);
  assert.equal(restarted.calls.transcribed.length, 1); assert.equal(restarted.calls.media.length, 1);
  assert.equal(restarted.calls.text.length, 1, "completed language overviews are not analyzed again");
  assert.deepEqual(result.follow_up, saved.follow_up); assertFreshPrompts(restarted.calls); assertReferences(result);
});


test("a multimodal question without a relevant visual candidate stays partial with no visual coverage", async () => {
  const previous = await parent(), next = fixture(), text = next.deps.analyzeText;
  next.deps.analyzeText = async (...args) => JSON.stringify({ ...JSON.parse(await text(...args)), relevance_score: 0 });
  const request: LongVideoRequest = { ...FOLLOWUP, mode: "multimodal", maxDetailWindows: 1 };
  const result = await researchLongVideo(request, next.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(result.status, "partial"); assertNoMedia(next.calls);
  assert.equal(result.coverage.overview_complete, true); assert.deepEqual(result.coverage.detail, []);
  assert.ok(result.warnings.some((item) => /visual|detail/i.test(item)));
  assertFreshPrompts(next.calls); assertReferences(result);
});

test("tampered pending child language material is rejected before any resumed analysis", async (t) => {
  const previous = await parent(), first = fixture(), controller = new AbortController();
  let baseline: LongVideoResult | undefined;
  await researchLongVideo(FOLLOWUP, first.deps, controller.signal, {
    materialReuse: reuse(previous), onCheckpoint: async (result) => {
      if (!baseline && result.plan) {
        baseline = structuredClone(result);
        controller.abort(new DOMException("Stop after saving raw material", "AbortError"));
      }
    },
  });
  assert.ok(baseline);
  const durable = baseline;
  const corruptions: Array<[string, (saved: LongVideoResult) => void]> = [
    ["foreign source", (saved) => { saved.evidence.find((item) => item.kind === "asr")!.source.part_id = "foreign-part"; }],
    ["empty raw text", (saved) => { saved.evidence.find((item) => item.kind === "asr")!.content = "  "; }],
  ];
  for (const [name, corrupt] of corruptions) await t.test(name, async () => {
    const saved = structuredClone(durable); corrupt(saved);
    const next = fixture(), result = await researchLongVideo(FOLLOWUP, next.deps, undefined, { previous: saved });
    assert.ok(result.errors.some((item) => item.code === "SESSION_INCOMPATIBLE"));
    assertNoMedia(next.calls); assert.deepEqual(next.calls.text, []);
  });
});

test("a corrupted child cannot resume with language detail work or multimodal without visual details", async (t) => {
  const previous = await parent(), first = fixture();
  const baseline = await researchLongVideo(FOLLOWUP, first.deps, undefined, { materialReuse: reuse(previous) });
  assert.equal(baseline.status, "complete");
  const combinations = [
    { name: "language with a paid detail window", mode: "language" as const, maxDetailWindows: 1 },
    { name: "multimodal without visual detail windows", mode: "multimodal" as const, maxDetailWindows: 0 },
  ];
  for (const combination of combinations) await t.test(combination.name, async () => {
    const saved = structuredClone(baseline);
    const request: LongVideoRequest = { ...FOLLOWUP, mode: combination.mode, maxDetailWindows: combination.maxDetailWindows };
    saved.request = { ...request };
    saved.plan!.max_detail_windows = combination.maxDetailWindows;
    const next = fixture(), result = await researchLongVideo(request, next.deps, undefined, { previous: saved });
    assert.ok(result.errors.some((item) => item.code === "SESSION_INCOMPATIBLE"));
    assertNoMedia(next.calls); assert.deepEqual(next.calls.text, []);
  });
});
