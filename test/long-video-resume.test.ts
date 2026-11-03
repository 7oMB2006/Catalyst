import assert from "node:assert/strict";
import test from "node:test";
import type { Evidence, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoRequest, LongVideoResult } from "../src/long-video-contracts.js";
import { researchLongVideo } from "../src/long-video.js";

const SOURCE_URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const REQUEST: LongVideoRequest = { url: SOURCE_URL, question: "这些注意力机制分别解决什么问题？", mode: "multimodal", language: "zh", maxDetailWindows: 0 };

function source(duration = 1800): SourceContext {
  return {
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: SOURCE_URL, canonicalUrl: SOURCE_URL, title: "Attention course, part 17", durationSeconds: duration, metadata: { part: 17 } },
    captions: { status: "auth_required", kind: "unknown", cues: [] },
    comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "auth_required" }, media: { status: "not_requested" }, comments: { status: "disabled" } },
    warnings: [],
  };
}
function primaryIn(prompt: string): Evidence[] {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const start = prompt.lastIndexOf(marker);
  assert.notEqual(start, -1);
  return JSON.parse(prompt.slice(start + marker.length));
}
function answer(prompt: string): string {
  const evidence = primaryIn(prompt).find((item) => item.kind !== "metadata");
  assert.ok(evidence);
  return JSON.stringify({
    analysis: `Observed explanation supported by ${evidence.id}.`,
    findings: [{ statement: `Supported concept in ${evidence.id}.`, evidence_ids: [evidence.id], limitations: ["Fixture interpretation."] }],
    relevance_score: 2, focus_offset_seconds: 60,
  });
}
function fixture(selected = source(), label = "first") {
  const calls = {
    resolves: 0,
    acquisitions: [] as Array<Parameters<LongVideoDependencies["acquireWindow"]>[1]>,
    transcriptions: [] as string[],
    media: [] as Array<{ path: string; prompt: string; detail: "low" | "default" }>,
    text: [] as string[], created: [] as string[], disposed: [] as string[],
  };
  const owned = (path: string) => {
    calls.created.push(path);
    return { path, dispose: async () => { assert.ok(!calls.disposed.includes(path)); calls.disposed.push(path); } };
  };
  const deps: LongVideoDependencies = {
    resolve: async () => { calls.resolves++; return structuredClone(selected); },
    acquireWindow: async (_video, request) => {
      calls.acquisitions.push({ ...request });
      return { ...owned(`/fixture/${label}-${calls.acquisitions.length}.mp4`), bytes: 1024, width: 854, height: 480, fps: 30 };
    },
    prepareWindow: async (path, _mode, detail) => owned(`${path}.${detail}.prepared.mp4`),
    transcribe: async (path) => { calls.transcriptions.push(path); return `${label} transcript from ${path}.`; },
    analyzeMedia: async (path, prompt, detail) => { calls.media.push({ path, prompt, detail }); return answer(prompt); },
    analyzeText: async (prompt) => { calls.text.push(prompt); return answer(prompt); },
  };
  return { deps, calls };
}
function acquiredWindows(calls: ReturnType<typeof fixture>["calls"]) {
  return calls.acquisitions.map((request) => [request.startSeconds, request.endSeconds]);
}
function assertReferences(result: LongVideoResult): void {
  const evidenceIds = new Set(result.evidence.map((item) => item.id));
  assert.equal(evidenceIds.size, result.evidence.length, "evidence IDs remain unique after merging attempts");
  for (const segment of result.segments.filter((item) => item.status === "complete")) {
    assert.ok(segment.analysis);
    assert.ok(segment.evidence_ids.length > 0);
    assert.ok(segment.evidence_ids.every((id) => evidenceIds.has(id)));
  }
  for (const finding of result.findings) assert.ok(finding.evidence_ids.every((id) => evidenceIds.has(id)));
}
function assertDisposed(calls: ReturnType<typeof fixture>["calls"]): void {
  assert.deepEqual([...calls.created].sort(), [...calls.disposed].sort());
}
async function failedMiddle() {
  const initial = fixture();
  const analyze = initial.deps.analyzeMedia;
  initial.deps.analyzeMedia = async (...args) => {
    const raw = await analyze(...args);
    if (primaryIn(args[1])[0].id === "overview:2:source") throw Object.assign(new Error("Fixture provider interruption"), { code: "UPSTREAM_ERROR", retryable: true });
    return raw;
  };
  const result = await researchLongVideo(REQUEST, initial.deps);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.segments.map((item) => item.status), ["complete", "failed", "complete"]);
  assertDisposed(initial.calls);
  return result;
}

test("resume reacquires only a failed overview and merges its replacement evidence without stale errors", async () => {
  const previous = await failedMiddle();
  const before = structuredClone(previous);
  assert.ok(previous.evidence.some((item) => item.id === "overview:2:asr" && item.content?.includes("first transcript")));
  const next = fixture(source(), "resumed");
  const result = await researchLongVideo(REQUEST, next.deps, undefined, { previous });
  assert.equal(result.status, "complete");
  assert.equal(next.calls.resolves, 1, "source metadata is freshly resolved");
  assert.deepEqual(acquiredWindows(next.calls), [[600, 1200]]);
  assert.equal(next.calls.transcriptions.length, 1); assert.equal(next.calls.media.length, 1);
  assert.equal(next.calls.text.length, 1, "synthesis is rebuilt from all successful reports");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.coverage.unreviewed, []);
  assert.equal(result.coverage.overview_complete, true);
  assert.equal(result.evidence.find((item) => item.id === "overview:1:asr")?.content, before.evidence.find((item) => item.id === "overview:1:asr")?.content);
  assert.match(result.evidence.find((item) => item.id === "overview:2:asr")?.content ?? "", /resumed transcript/);
  assert.deepEqual(previous, before, "continuation must not mutate the caller's saved revision");
  assertReferences(result); assertDisposed(next.calls);
});

test("an interpreted but structurally partial overview is retried rather than treated as successful coverage", async () => {
  const first = fixture(source(1200));
  const analyze = first.deps.analyzeMedia;
  first.deps.analyzeMedia = async (...args) => {
    const raw = await analyze(...args);
    return primaryIn(args[1])[0].id === "overview:2:source"
      ? JSON.stringify({ analysis: "An uncited hypothesis from the first attempt.", findings: [{ statement: "Invalid old claim", evidence_ids: ["invented:source"] }] })
      : raw;
  };
  const previous = await researchLongVideo(REQUEST, first.deps);
  assert.equal(previous.segments[1].status, "partial");
  const next = fixture(source(1200), "retry");
  const result = await researchLongVideo(REQUEST, next.deps, undefined, { previous });
  assert.equal(result.status, "complete");
  assert.deepEqual(acquiredWindows(next.calls), [[600, 1200]]);
  assert.doesNotMatch(result.segments[1].analysis ?? "", /uncited hypothesis/);
  assert.ok(!result.findings.some((finding) => finding.statement === "Invalid old claim"));
  assertReferences(result); assertDisposed(first.calls); assertDisposed(next.calls);
});

test("a checkpoint saved before cancellation can resume in a fresh invocation without repeating completed work", async () => {
  const first = fixture();
  const controller = new AbortController();
  let checkpoint: LongVideoResult | undefined;
  const interrupted = await researchLongVideo(REQUEST, first.deps, controller.signal, {
    onCheckpoint: async (result) => {
      if (!checkpoint && result.segments[0]?.status === "complete") {
        checkpoint = structuredClone(result);
        controller.abort(new DOMException("Fixture host stopped the call", "AbortError"));
      }
    },
  });
  assert.ok(checkpoint);
  assert.equal(interrupted.status, "partial");
  assert.deepEqual(acquiredWindows(first.calls), [[0, 600]]);
  assert.deepEqual(checkpoint.segments.map((item) => item.status), ["complete", "pending", "pending"]);
  const next = fixture(source(), "after-restart");
  const result = await researchLongVideo(REQUEST, next.deps, undefined, { previous: structuredClone(checkpoint) });
  assert.equal(result.status, "complete");
  assert.deepEqual(acquiredWindows(next.calls), [[600, 1200], [1200, 1800]]);
  assert.equal(next.calls.transcriptions.length, 2); assert.equal(next.calls.media.length, 2);
  assertReferences(result); assertDisposed(first.calls); assertDisposed(next.calls);
});

test("all detail windows are checkpointed before processing and resume preserves completed detail windows", async () => {
  const request: LongVideoRequest = { ...REQUEST, maxDetailWindows: 2 };
  const first = fixture(source(1200));
  const checkpoints: LongVideoResult[] = [];
  const analyze = first.deps.analyzeMedia;
  first.deps.analyzeMedia = async (...args) => {
    const raw = await analyze(...args);
    if (primaryIn(args[1])[0].id === "detail:1:source") throw Object.assign(new Error("Fixture detail model failure"), { code: "UPSTREAM_ERROR", retryable: true });
    return raw;
  };
  const previous = await researchLongVideo(request, first.deps, undefined, { onCheckpoint: async (result) => { checkpoints.push(structuredClone(result)); } });
  const detail = previous.segments.filter((item) => item.phase === "detail");
  assert.deepEqual(detail.map((item) => item.status), ["failed", "complete"]);
  assert.ok(checkpoints.some((result) => {
    const planned = result.segments.filter((item) => item.phase === "detail");
    return planned.length === 2 && planned.every((item) => item.status === "pending");
  }), "both detail windows exist durably before the first begins");
  const next = fixture(source(1200), "detail-retry");
  const result = await researchLongVideo(request, next.deps, undefined, { previous });
  assert.equal(result.status, "complete");
  assert.deepEqual(acquiredWindows(next.calls), [[detail[0].window.start_seconds, detail[0].window.end_seconds]]);
  assert.equal(next.calls.media[0].detail, "default");
  assert.equal(next.calls.transcriptions.length, 1);
  assert.equal(result.segments.filter((item) => item.phase === "detail").length, 2);
  assert.deepEqual(result.segments.find((item) => item.id === "detail:2"), detail[1]);
  assert.deepEqual(result.coverage.detail, detail.map((item) => item.window));
  assertReferences(result); assertDisposed(first.calls); assertDisposed(next.calls);
});

test("resuming a complete record only rebuilds synthesis and incurs no segment acquisition, ASR or analysis", async () => {
  const request = { ...REQUEST, maxDetailWindows: 1 };
  const first = fixture(source(1200));
  const previous = await researchLongVideo(request, first.deps);
  assert.equal(previous.status, "complete");
  const next = fixture(source(1200), "complete-resume");
  const result = await researchLongVideo(request, next.deps, undefined, { previous });
  assert.equal(result.status, "complete"); assert.equal(next.calls.resolves, 1);
  assert.equal(next.calls.acquisitions.length, 0); assert.equal(next.calls.transcriptions.length, 0); assert.equal(next.calls.media.length, 0);
  assert.equal(next.calls.text.length, 1); assert.equal(result.processing.download_bytes, 0);
  assertReferences(result); assertDisposed(first.calls);
});

test("continuation rejects changed questions, channels, ranges and processing plans before media work", async (context) => {
  const first = fixture(source(1200));
  const previous = await researchLongVideo(REQUEST, first.deps);
  const changes: Array<[string, Partial<LongVideoRequest>]> = [
    ["question", { question: "另一种机制怎样推导？" }],
    ["mode", { mode: "vision" }],
    ["language", { language: "en" }],
    ["range", { startSeconds: 0, endSeconds: 600 }],
    ["segmentation", { segmentSeconds: 300 }],
    ["detail count", { maxDetailWindows: 1 }],
    ["detail length", { detailWindowSeconds: 60 }],
    ["source quality", { sourceQuality: { profile: "standard", onUnavailable: "warn" } }],
  ];
  for (const [name, change] of changes) await context.test(name, async () => {
    const next = fixture(source(1200));
    const result = await researchLongVideo({ ...REQUEST, ...change }, next.deps, undefined, { previous });
    assert.ok(result.errors.some((error) => error.code === "SESSION_INCOMPATIBLE"));
    assert.equal(next.calls.acquisitions.length, 0); assert.equal(next.calls.transcriptions.length, 0); assert.equal(next.calls.media.length, 0); assert.equal(next.calls.text.length, 0);
  });
});

test("continuation validates freshly resolved platform, video, part, canonical URL and source duration", async (context) => {
  const first = fixture(source(1200));
  const previous = await researchLongVideo(REQUEST, first.deps);
  const changes: Array<[string, (selected: SourceContext) => void]> = [
    ["platform", (selected) => { selected.video.platform = "youtube"; }],
    ["video ID", (selected) => { selected.video.id = "BV1Different"; }],
    ["part ID", (selected) => { selected.video.partId = "different-cid"; }],
    ["canonical URL", (selected) => { selected.video.canonicalUrl = SOURCE_URL.replace("p=17", "p=18"); }],
    ["duration", (selected) => { selected.video.durationSeconds = 1201; }],
  ];
  for (const [name, change] of changes) await context.test(name, async () => {
    const selected = source(1200); change(selected);
    const next = fixture(selected);
    const result = await researchLongVideo(REQUEST, next.deps, undefined, { previous });
    assert.equal(next.calls.resolves, 1);
    assert.ok(result.errors.some((error) => error.code === "SESSION_INCOMPATIBLE"));
    assert.equal(next.calls.acquisitions.length, 0); assert.equal(next.calls.media.length, 0); assert.equal(next.calls.text.length, 0);
  });
});

test("malformed or foreign source evidence cannot enter synthesis through a saved complete segment", async (context) => {
  const first = fixture(source(1200));
  const baseline = await researchLongVideo(REQUEST, first.deps);
  const corruptions: Array<[string, (saved: LongVideoResult) => void]> = [
    ["missing primary reference", (saved) => { saved.segments[0].evidence_ids = ["missing:source"]; }],
    ["foreign part evidence", (saved) => { saved.evidence.find((item) => item.kind === "multimodal")!.source.part_id = "foreign-part"; }],
    ["duplicate evidence ID", (saved) => { saved.evidence.push(structuredClone(saved.evidence[1])); }],
    ["wrong segment window", (saved) => { saved.segments[0].window.end_seconds = 900; }],
    ["empty complete report", (saved) => { saved.segments[0].analysis = null; }],
    ["failed window references another completed window", (saved) => { saved.segments[1].status = "failed"; saved.segments[1].error = "UPSTREAM_ERROR"; saved.segments[1].evidence_ids = ["overview:1:source"]; }],
  ];
  for (const [name, corrupt] of corruptions) await context.test(name, async () => {
    const previous = structuredClone(baseline); corrupt(previous);
    const next = fixture(source(1200));
    const result = await researchLongVideo(REQUEST, next.deps, undefined, { previous });
    assert.ok(result.errors.some((error) => error.code === "SESSION_INCOMPATIBLE"));
    assert.equal(next.calls.acquisitions.length, 0); assert.equal(next.calls.text.length, 0);
  });
});

test("resume starts a fresh file budget and deadline while retaining prior successful evidence", async () => {
  const request: LongVideoRequest = { ...REQUEST, maxDownloadMB: 32, timeoutSeconds: 60, windowTimeoutSeconds: 30 };
  const first = fixture(source(1200));
  const initialAcquire = first.deps.acquireWindow;
  first.deps.acquireWindow = async (...args) => {
    if ((args[1].maxAcquiredBytes ?? Infinity) < 20 * 1024 * 1024) throw Object.assign(new Error("Fixture acquisition needs more remaining bytes"), { code: "DOWNLOAD_BUDGET_EXCEEDED" });
    return { ...await initialAcquire(...args), bytes: 20 * 1024 * 1024 };
  };
  const previous = await researchLongVideo(request, first.deps);
  assert.equal(previous.status, "partial");
  assert.equal(previous.segments[0].status, "complete");
  const next = fixture(source(1200), "fresh-budget");
  const resumedAcquire = next.deps.acquireWindow;
  next.deps.acquireWindow = async (...args) => {
    assert.equal(args[1].maxAcquiredBytes, 64 * 1024 * 1024);
    assert.ok(args[2].deadlineMs > Date.now() + 45_000, "resume uses the adjusted new window deadline");
    return { ...await resumedAcquire(...args), bytes: 20 * 1024 * 1024 };
  };
  const result = await researchLongVideo({ ...request, maxDownloadMB: 64, timeoutSeconds: 120, windowTimeoutSeconds: 60 }, next.deps, undefined, { previous });
  assert.equal(result.status, "complete");
  assert.deepEqual(acquiredWindows(next.calls), [[600, 1200]]);
  assert.equal(result.processing.download_bytes, 20 * 1024 * 1024, "per-invocation accounting excludes old file costs");
  assertReferences(result); assertDisposed(first.calls); assertDisposed(next.calls);
});

test("a failed synthesis resumes from completed reports without rerunning source windows", async () => {
  const first = fixture(source(600));
  first.deps.analyzeText = async () => { throw Object.assign(new Error("Fixture synthesis deadline"), { code: "UPSTREAM_ERROR", retryable: true }); };
  const previous = await researchLongVideo(REQUEST, first.deps);
  assert.equal(previous.status, "partial");
  assert.equal(previous.segments[0].status, "complete");
  const next = fixture(source(600), "synthesis-retry");
  const result = await researchLongVideo(REQUEST, next.deps, undefined, { previous });
  assert.equal(result.status, "complete");
  assert.equal(next.calls.acquisitions.length, 0); assert.equal(next.calls.transcriptions.length, 0); assert.equal(next.calls.media.length, 0);
  assert.equal(next.calls.text.length, 1); assert.deepEqual(result.errors, []);
  assertReferences(result); assertDisposed(first.calls);
});

test("checkpoints include the planned source, each completed window and the final synthesized result", async () => {
  const first = fixture(source(1200));
  const checkpoints: LongVideoResult[] = [];
  const result = await researchLongVideo(REQUEST, first.deps, undefined, { onCheckpoint: async (value) => { checkpoints.push(structuredClone(value)); } });
  assert.equal(result.status, "complete");
  assert.ok(checkpoints.some((value) => value.plan && value.segments.length === 2 && value.segments.every((segment) => segment.status === "pending")));
  assert.ok(checkpoints.some((value) => value.segments[0]?.status === "complete" && value.segments[1]?.status === "pending"));
  assert.equal(checkpoints.at(-1)?.status, "complete");
  assert.deepEqual(checkpoints.at(-1)?.findings, result.findings);
  assert.deepEqual(checkpoints.at(-1)?.coverage, result.coverage);
  assert.deepEqual(checkpoints.at(-1)?.analysis, result.analysis);
  assert.equal(checkpoints[0].segments.filter((segment) => segment.status === "complete").length, 0, "saved snapshots do not change after subsequent segment mutations");
  assertDisposed(first.calls);
});

test("language and visual continuations retain their evidence boundaries when completing a missing window", async (context) => {
  for (const mode of ["language", "vision"] as const) await context.test(mode, async () => {
    const request = { ...REQUEST, mode };
    const first = fixture(source(1200));
    const failSecond = (prompt: string) => {
      if (!prompt.includes("SYNTHESIS:") && primaryIn(prompt)[0].id === "overview:2:source") throw Object.assign(new Error("Fixture window failure"), { code: "UPSTREAM_ERROR" });
    };
    const analyzeMedia = first.deps.analyzeMedia, analyzeText = first.deps.analyzeText;
    first.deps.analyzeMedia = async (...args) => { failSecond(args[1]); return analyzeMedia(...args); };
    first.deps.analyzeText = async (...args) => { failSecond(args[0]); return analyzeText(...args); };
    const previous = await researchLongVideo(request, first.deps);
    assert.equal(previous.status, "partial");
    const next = fixture(source(1200), `${mode}-resume`);
    const result = await researchLongVideo(request, next.deps, undefined, { previous });
    assert.equal(result.status, "complete");
    assert.deepEqual(acquiredWindows(next.calls), [[600, 1200]]);
    assert.equal(next.calls.transcriptions.length, mode === "language" ? 1 : 0);
    assert.equal(next.calls.media.length, mode === "vision" ? 1 : 0);
    const primary = result.evidence.filter((item) => item.kind !== "metadata");
    assert.ok(primary.every((item) => item.kind === (mode === "language" ? "asr" : "visual")));
    if (mode === "vision") assert.ok(primary.every((item) => item.data?.audio_removed === true));
    assertReferences(result); assertDisposed(first.calls); assertDisposed(next.calls);
  });
});
