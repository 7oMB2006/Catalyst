import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { Evidence, ExecutionContext, MediaAsset, ResearchRequest, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoRequest } from "../src/long-video-contracts.js";
import { researchLongVideo } from "../src/long-video.js";

const URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17&share_source=copy_web&vd_source=fixture-private-share-token";
const CANONICAL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const REQUEST: LongVideoRequest = { url: URL, question: "本集介绍了哪些自注意力机制，分别解决什么问题？", mode: "multimodal", language: "zh", maxDetailWindows: 0 };

function source(duration = 4276): SourceContext {
  return {
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: URL, canonicalUrl: CANONICAL, title: "Course collection", durationSeconds: duration, metadata: { part: 17, part_title: "各式各样神奇的自注意力机制 Selfattention" } },
    captions: { status: "auth_required", kind: "unknown", cues: [], reason: "Platform subtitles require an authorized session." },
    comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "auth_required" }, media: { status: "not_requested" }, comments: { status: "disabled" } },
    warnings: ["Platform subtitles require an authorized session."],
  };
}
function evidenceIn(prompt: string): Evidence[] {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const start = prompt.lastIndexOf(marker);
  assert.notEqual(start, -1, "the provider must be given explicit source evidence");
  return JSON.parse(prompt.slice(start + marker.length)) as Evidence[];
}
function response(prompt: string, navigation: { relevance_score?: unknown; focus_offset_seconds?: unknown } = {}): string {
  const evidence = evidenceIn(prompt).find((item) => item.kind !== "metadata");
  assert.ok(evidence);
  return JSON.stringify({ analysis: `Observed concepts from ${evidence.id}; exact formula text remains uncertain.`, findings: [{ statement: `A concept is explained in ${evidence.id}.`, evidence_ids: [evidence.id], limitations: ["Fixture interpretation only."] }], relevance_score: 1, focus_offset_seconds: 60, ...navigation });
}
function fixture(selected = source()) {
  const calls = {
    resolves: 0, acquisitions: [] as Array<Parameters<LongVideoDependencies["acquireWindow"]>[1]>, preparations: [] as Array<{ sourcePath: string; mode: ResearchRequest["mode"]; detail: "low" | "default" }>,
    transcriptions: [] as string[], media: [] as Array<{ path: string; prompt: string; detail: "low" | "default" }>, text: [] as string[],
    created: [] as string[], disposed: [] as string[],
  };
  const owned = (path: string) => {
    calls.created.push(path);
    return { path, dispose: async () => { assert.ok(!calls.disposed.includes(path), "resource disposal must not be duplicated"); calls.disposed.push(path); } };
  };
  const deps: LongVideoDependencies = {
    resolve: async (request, context) => {
      calls.resolves++; assert.ok(context.signal); assert.ok(context.deadlineMs > Date.now());
      assert.equal(new globalThis.URL(request.url).searchParams.get("p"), "17");
      return structuredClone(selected);
    },
    acquireWindow: async (video, request, context) => {
      assert.ok(context.signal); assert.equal(video.partId, "38253823575"); assert.equal(video.canonicalUrl, CANONICAL);
      calls.acquisitions.push({ ...request });
      return { ...owned(`/fixture/source-${calls.acquisitions.length}.mp4`), bytes: 1024, width: 854, height: 480, fps: 30 };
    },
    prepareWindow: async (path, mode, detail, context) => {
      assert.ok(context.signal); calls.preparations.push({ sourcePath: path, mode, detail });
      return owned(`${path}.${detail}.prepared.mp4`);
    },
    transcribe: async (path, context, language) => {
      assert.ok(context.signal); assert.equal(language, "zh"); calls.transcriptions.push(path);
      return "本片段的实际语音转写；不包括未见的公式和画面。";
    },
    analyzeMedia: async (path, prompt, detail, context) => {
      assert.ok(context.signal); calls.media.push({ path, prompt, detail }); return response(prompt);
    },
    analyzeText: async (prompt, context) => {
      assert.ok(context.signal); calls.text.push(prompt); return response(prompt);
    },
  };
  return { deps, calls };
}
function assertAllDisposed(calls: ReturnType<typeof fixture>["calls"]): void {
  assert.deepEqual([...calls.disposed].sort(), [...calls.created].sort());
}

test("a 71-minute selected Bilibili part receives contiguous overview coverage including the final 76 seconds", async () => {
  const { deps, calls } = fixture();
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(result.status, "complete");
  assert.equal(result.video?.partId, "38253823575");
  assert.equal(result.video?.metadata?.part, 17);
  assert.equal(result.video?.metadata?.part_title, "各式各样神奇的自注意力机制 Selfattention");
  assert.equal(result.video?.durationSeconds, 4276);
  assert.equal(result.video?.canonicalUrl, CANONICAL);
  assert.equal(result.plan?.overview_windows.length, 8);
  assert.deepEqual(result.plan?.overview_windows, [
    { start_seconds: 0, end_seconds: 600 }, { start_seconds: 600, end_seconds: 1200 },
    { start_seconds: 1200, end_seconds: 1800 }, { start_seconds: 1800, end_seconds: 2400 },
    { start_seconds: 2400, end_seconds: 3000 }, { start_seconds: 3000, end_seconds: 3600 },
    { start_seconds: 3600, end_seconds: 4200 }, { start_seconds: 4200, end_seconds: 4276 },
  ]);
  assert.deepEqual(calls.acquisitions.map((request) => [request.startSeconds, request.endSeconds]), result.plan!.overview_windows.map((window) => [window.start_seconds, window.end_seconds]));
  assert.ok(calls.acquisitions.every((request) => request.mode === "multimodal" && request.mediaDetail === "low"));
  assert.ok(result.segments.every((segment) => segment.basis === "audio_video"));
  assert.equal(calls.transcriptions.length, 8, "each video window must also have an explicit language transcript");
  const media = result.evidence.filter((item) => item.kind === "multimodal");
  assert.equal(media.length, 8);
  for (const item of media) {
    assert.equal(item.source.part_id, "38253823575"); assert.equal(item.source.url, CANONICAL);
    assert.deepEqual(item.data?.channels, ["audio", "video"]); assert.equal(item.data?.audio_removed, false);
    assert.equal(item.precision, "requested_window");
  }
  assert.deepEqual(result.coverage.overview, result.plan!.overview_windows);
  assert.equal(result.coverage.overview_complete, true);
  assert.deepEqual(result.coverage.detail, []); assert.deepEqual(result.coverage.unreviewed, []);
  const evidenceIds = new Set(result.evidence.map((item) => item.id));
  assert.ok(result.findings.length > 0 && result.findings.every((finding) => finding.verification === "unverified" && finding.evidence_ids.every((id) => evidenceIds.has(id))));
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-share-token|vd_source|share_source/);
  assert.equal(result.processing.download_bytes, 8192);
  assertAllDisposed(calls);
});

test("multimodal overview and detail windows expose separate ASR and video evidence to analysis and synthesis", async () => {
  const { deps, calls } = fixture(source(1200));
  const originalMedia = deps.analyzeMedia;
  deps.analyzeMedia = async (...args) => {
    await originalMedia(...args);
    const primary = evidenceIn(args[1]);
    assert.deepEqual(primary.map((item) => item.kind), ["multimodal", "asr"]);
    const [video, transcript] = primary;
    assert.equal(transcript.id, video.id.replace(/:source$/, ":asr"));
    assert.deepEqual(transcript.time_range, video.time_range);
    assert.equal(transcript.source.part_id, "38253823575");
    assert.equal(transcript.source.origin, "windowed_provider_asr");
    assert.match(transcript.content ?? "", /本片段的实际语音转写/);
    assert.match(transcript.limitations.join(" "), /not platform captions|not.*independently verified transcript/);
    assert.match(args[1], /Use the supplied ASR evidence as the language channel/);
    assert.match(args[1], /Distinguish ASR text from what is visible/);
    assert.ok(args[1].includes(`VALID evidence_ids: ${JSON.stringify(primary.map((item) => item.id))}`));
    return JSON.stringify({ analysis: "The transcript explains a concept; a visible diagram is considered separately.", findings: [
      { statement: "Spoken explanation", evidence_ids: [transcript.id] },
      { statement: "Visible diagram observation", evidence_ids: [video.id] },
    ], relevance_score: 2, focus_offset_seconds: 180 });
  };
  let synthesisCalls = 0;
  deps.analyzeText = async (prompt) => {
    synthesisCalls++;
    const primary = evidenceIn(prompt);
    const speech = primary.find((item) => item.id === "overview:1:asr");
    const video = primary.find((item) => item.id === "overview:1:source");
    assert.equal(speech?.kind, "asr"); assert.equal(video?.kind, "multimodal");
    assert.match(prompt, /Separate what is heard from what is seen/);
    return JSON.stringify({ analysis: "An ASR-based spoken explanation and a separately observed video diagram.", findings: [
      { statement: "Explanation from the generated transcript", evidence_ids: [speech!.id] },
      { statement: "Observation from the video", evidence_ids: [video!.id] },
    ] });
  };
  const result = await researchLongVideo({ ...REQUEST, maxDetailWindows: 1 }, deps);
  assert.equal(result.status, "complete"); assert.equal(synthesisCalls, 1);
  assert.equal(calls.acquisitions.length, 3); assert.equal(calls.transcriptions.length, 3);
  assert.equal(calls.media.length, 3); assert.equal(calls.media[2].detail, "default");
  assert.equal(result.segments.filter((segment) => segment.phase === "detail").length, 1);
  assert.ok(result.segments.every((segment) => segment.evidence_ids.length === 2));
  assert.deepEqual(result.findings.map((finding) => finding.evidence_ids), [["overview:1:asr"], ["overview:1:source"]]);
  assert.ok(result.findings.every((finding) => finding.verification === "unverified"));
  assertAllDisposed(calls);
});

test("empty multimodal ASR leaves its window unreviewed and prevents a false complete result", async () => {
  const { deps, calls } = fixture(source(1200));
  const original = deps.transcribe;
  deps.transcribe = async (...args) => {
    const transcript = await original(...args);
    return calls.transcriptions.length === 2 ? "   " : transcript;
  };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(result.status, "partial");
  assert.equal(calls.transcriptions.length, 2); assert.equal(calls.media.length, 1);
  assert.deepEqual(result.segments.map((segment) => segment.status), ["complete", "failed"]);
  assert.equal(result.segments[1].error, "TRANSCRIPT_UNAVAILABLE");
  assert.deepEqual(result.coverage.overview, [{ start_seconds: 0, end_seconds: 600 }]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  assert.equal(result.coverage.overview_complete, false);
  assert.ok(result.errors.some((error) => error.code === "TRANSCRIPT_UNAVAILABLE"));
  assert.ok(result.findings.every((finding) => finding.evidence_ids.every((id) => !id.startsWith("overview:2:"))));
  assertAllDisposed(calls);
});

test("closer looks map clip-local focus proposals back to source time and remain inside the selected nonzero interval", async () => {
  const { deps, calls } = fixture();
  const original = deps.analyzeMedia;
  deps.analyzeMedia = async (...args) => {
    await original(...args);
    const primary = evidenceIn(args[1])[0];
    return response(args[1], primary.time_range?.start_seconds === 1500 ? { relevance_score: 3, focus_offset_seconds: 590 } : { relevance_score: 1, focus_offset_seconds: -20 });
  };
  const result = await researchLongVideo({ ...REQUEST, startSeconds: 900, endSeconds: 2100, maxDetailWindows: 2 }, deps);
  assert.equal(result.status, "complete");
  const detail = result.segments.filter((segment) => segment.phase === "detail");
  assert.deepEqual(detail.map((segment) => segment.window), [{ start_seconds: 1980, end_seconds: 2100 }, { start_seconds: 1140, end_seconds: 1260 }]);
  assert.equal(result.segments[0].proposed_focus_offset_seconds, undefined, "negative proposal must be ignored instead of becoming a source timestamp");
  assert.equal(result.segments[1].proposed_focus_offset_seconds, 590);
  assert.deepEqual(calls.media.map((call) => call.detail), ["low", "low", "default", "default"]);
  assert.deepEqual(calls.preparations.map((call) => call.detail), ["low", "low", "default", "default"]);
  assert.ok(calls.acquisitions.every((request) => request.startSeconds! >= 900 && request.endSeconds! <= 2100));
  assert.deepEqual(result.coverage.detail, detail.map((segment) => segment.window));
  assert.match(result.coverage.limitations.join(" "), /proposed.*select clips.*do not prove exact event times/i);
  assertAllDisposed(calls);
});

test("one failed middle window preserves successful reports and explicitly leaves that interval unreviewed", async () => {
  const { deps, calls } = fixture(source(1800));
  const original = deps.analyzeMedia;
  deps.analyzeMedia = async (...args) => {
    await original(...args);
    if (evidenceIn(args[1])[0].time_range?.start_seconds === 600) throw Object.assign(new Error("Temporary model failure"), { code: "UPSTREAM_ERROR", retryable: true });
    return response(args[1]);
  };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.segments.map((segment) => segment.status), ["complete", "failed", "complete"]);
  assert.deepEqual(result.coverage.overview, [{ start_seconds: 0, end_seconds: 600 }, { start_seconds: 1200, end_seconds: 1800 }]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  assert.equal(result.coverage.overview_complete, false);
  assert.equal(result.errors[0].code, "UPSTREAM_ERROR"); assert.match(result.errors[0].stage, /overview:2/);
  assert.ok(result.segments[0].analysis && result.segments[2].analysis);
  assert.ok(result.analysis); assert.equal(calls.acquisitions.length, 3);
  assertAllDisposed(calls);
});

test("a source window whose analysis failed cannot be cited by the final synthesis", async () => {
  const { deps, calls } = fixture(source(1200));
  deps.analyzeMedia = async (_path, prompt) => {
    if (evidenceIn(prompt)[0].id === "overview:2:source") throw Object.assign(new Error("Temporary model failure"), { code: "UPSTREAM_ERROR" });
    return response(prompt);
  };
  let synthesised = false;
  deps.analyzeText = async (prompt) => {
    synthesised = true;
    assert.ok(prompt.includes("SYNTHESIS:"));
    assert.ok(evidenceIn(prompt).some((evidence) => evidence.id === "overview:1:source"));
    assert.ok(!evidenceIn(prompt).some((evidence) => evidence.id === "overview:2:source"), "acquired but uninterpreted input must not enter synthesis as usable evidence");
    return JSON.stringify({ analysis: "One observed result; one uncited hypothesis.", findings: [
      { statement: "An observed concept", evidence_ids: ["overview:1:source"] },
      { statement: "A concept from the failed window", evidence_ids: ["overview:2:source"] },
    ] });
  };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(synthesised, true); assert.equal(result.status, "partial");
  assert.deepEqual(result.findings.map((finding) => finding.evidence_ids), [["overview:1:source"]]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  assert.match(result.warnings.join(" "), /discarded.*evidence references were invalid/);
  assertAllDisposed(calls);
});

test("source authentication failure stops further acquisition without claiming coverage", async () => {
  const { deps, calls } = fixture(source(1800));
  let attempts = 0;
  deps.acquireWindow = async () => { attempts++; throw Object.assign(new Error("Authorized source access is required."), { code: "AUTH_REQUIRED" }); };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(attempts, 1); assert.equal(result.status, "unavailable");
  assert.deepEqual(result.segments.map((segment) => segment.status), ["failed", "pending", "pending"]);
  assert.deepEqual(result.coverage.overview, []);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 0, end_seconds: 1800 }]);
  assert.equal(result.errors[0].code, "AUTH_REQUIRED");
  assert.equal(calls.media.length, 0); assert.equal(calls.text.length, 0);
});

test("one temporary acquisition failure refreshes the window once without resetting its deadline or part identity", async (context) => {
  const now = 1_000_000;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { deps, calls } = fixture(source(600));
  const acquire = deps.acquireWindow;
  const attempts: Array<{ request: Parameters<LongVideoDependencies["acquireWindow"]>[1]; context: ExecutionContext; cid: string | undefined; canonical: string }> = [];
  deps.acquireWindow = async (...args) => {
    attempts.push({ request: { ...args[1] }, context: args[2], cid: args[0].partId, canonical: args[0].canonicalUrl });
    if (attempts.length === 1) {
      context.mock.timers.tick(1000);
      throw Object.assign(new Error("Temporary source fetch timeout"), { code: "TIMEOUT", retryable: true });
    }
    return acquire(...args);
  };
  const result = await researchLongVideo({ ...REQUEST, windowTimeoutSeconds: 15, maxDownloadMB: 32 }, deps);
  assert.equal(result.status, "complete"); assert.equal(result.errors.length, 0); assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => [attempt.cid, attempt.canonical, attempt.request.startSeconds, attempt.request.endSeconds, attempt.request.maxAcquiredBytes]), [
    ["38253823575", CANONICAL, 0, 600, 32 * 1024 * 1024], ["38253823575", CANONICAL, 0, 600, 32 * 1024 * 1024],
  ]);
  assert.equal(attempts[0].context, attempts[1].context);
  assert.equal(attempts[1].context.deadlineMs, now + 15_000);
  assert.equal(attempts[1].context.deadlineMs - Date.now(), 14_000, "retry must consume the original window budget");
  assert.equal(attempts[1].context.signal.aborted, false);
  assert.equal(calls.media.length, 1); assert.equal(calls.transcriptions.length, 1);
  assert.equal(result.processing.download_bytes, 1024);
  assert.match(result.warnings.join(" "), /temporary acquisition failure.*retried once.*same window deadline/);
  assert.deepEqual(result.coverage.unreviewed, []);
  assertAllDisposed(calls);
});

test("repeated temporary acquisition errors stop after two attempts and retain neighboring successful windows", async () => {
  const { deps, calls } = fixture(source(1800));
  const acquire = deps.acquireWindow;
  const attempts = new Map<number, number>();
  const failedContexts: ExecutionContext[] = [];
  deps.acquireWindow = async (...args) => {
    const start = args[1].startSeconds!;
    attempts.set(start, (attempts.get(start) ?? 0) + 1);
    if (start === 600) {
      failedContexts.push(args[2]);
      throw Object.assign(new Error("Temporary stream acquisition failure"), { code: "ACQUISITION_FAILED", retryable: true });
    }
    return acquire(...args);
  };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(result.status, "partial");
  assert.deepEqual([...attempts], [[0, 1], [600, 2], [1200, 1]]);
  assert.equal(failedContexts[0], failedContexts[1], "both attempts share one window context");
  assert.equal(result.errors.length, 1); assert.equal(result.errors[0].code, "ACQUISITION_FAILED");
  assert.deepEqual(result.segments.map((segment) => segment.status), ["complete", "failed", "complete"]);
  assert.deepEqual(result.coverage.overview, [{ start_seconds: 0, end_seconds: 600 }, { start_seconds: 1200, end_seconds: 1800 }]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  assert.equal(result.warnings.filter((warning) => /temporary acquisition failure/.test(warning)).length, 1);
  assert.ok(result.segments[0].analysis && result.segments[2].analysis && result.analysis);
  assertAllDisposed(calls);
});

test("authentication, range and quality errors are not retried even if their error objects say retryable", async () => {
  for (const code of ["AUTH_REQUIRED", "INVALID_WINDOW", "QUALITY_UNAVAILABLE"]) {
    const { deps, calls } = fixture(source(600));
    let attempts = 0;
    deps.acquireWindow = async () => { attempts++; throw Object.assign(new Error(`Permanent ${code}`), { code, retryable: true }); };
    const result = await researchLongVideo(REQUEST, deps);
    assert.equal(attempts, 1, code); assert.equal(result.status, "unavailable", code);
    assert.equal(result.errors[0].code, code);
    assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 0, end_seconds: 600 }]);
    assert.ok(!result.warnings.some((warning) => /retried once/.test(warning)));
    assert.equal(calls.media.length, 0);
  }
});

test("an otherwise temporary acquisition failure is not retried without its explicit retryable flag", async () => {
  const { deps } = fixture(source(600));
  let attempts = 0;
  deps.acquireWindow = async () => { attempts++; throw Object.assign(new Error("Not retryable upstream failure"), { code: "UPSTREAM_ERROR", retryable: false }); };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(attempts, 1); assert.equal(result.status, "unavailable");
  assert.equal(result.errors[0].code, "UPSTREAM_ERROR");
  assert.ok(!result.warnings.some((warning) => /retried once/.test(warning)));
});

for (const reason of ["AbortError", "TimeoutError"] as const) {
  test(`${reason} during analysis preserves earlier coverage and disposes the interrupted media`, async () => {
    const controller = new AbortController();
    const { deps, calls } = fixture(source(1800));
    const original = deps.analyzeMedia;
    deps.analyzeMedia = async (...args) => {
      await original(...args);
      if (evidenceIn(args[1])[0].time_range?.start_seconds === 600) {
        controller.abort(new DOMException("Fixture interruption", reason));
        return new Promise<string>(() => undefined);
      }
      return response(args[1]);
    };
    const result = await researchLongVideo(REQUEST, deps, controller.signal);
    assert.equal(result.status, "partial");
    assert.equal(calls.acquisitions.length, 2); assert.equal(calls.text.length, 0, "interrupted requests must not start a synthesis call");
    assert.deepEqual(result.coverage.overview, [{ start_seconds: 0, end_seconds: 600 }]);
    assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1800 }]);
    assert.ok(result.errors.some((error) => error.code === (reason === "TimeoutError" ? "TIMEOUT" : "CANCELLED")));
    assert.match(result.analysis ?? "", /overview:1/);
    assertAllDisposed(calls);
  });
}

test("an acquisition completing after cancellation is still disposed", async () => {
  const { deps } = fixture(source(600));
  const controller = new AbortController();
  let acquired!: (asset: MediaAsset) => void, started!: () => void, disposed = 0;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  deps.acquireWindow = async () => { started(); return new Promise<MediaAsset>((resolve) => { acquired = resolve; }); };
  const task = researchLongVideo(REQUEST, deps, controller.signal);
  await startedPromise;
  controller.abort(new DOMException("Fixture cancellation", "AbortError"));
  const result = await task;
  assert.equal(result.status, "unavailable");
  acquired({ path: "/fixture/late.mp4", bytes: 1024, dispose: async () => { disposed++; } });
  await setImmediate();
  assert.equal(disposed, 1);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 0, end_seconds: 600 }]);
});

test("an insufficient plan budget rejects before downloads and reports the whole requested interval as unreviewed", async () => {
  const { deps, calls } = fixture();
  const result = await researchLongVideo({ ...REQUEST, maxSegments: 7 }, deps);
  assert.equal(result.status, "unavailable"); assert.equal(result.errors[0].code, "PLAN_BUDGET_EXCEEDED");
  assert.equal(calls.acquisitions.length, 0); assert.equal(calls.media.length, 0); assert.equal(calls.text.length, 0);
  assert.equal(result.coverage.overview_complete, false);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 0, end_seconds: 4276 }]);
});

test("a cumulative acquired-file budget stops later windows without inventing their analysis", async () => {
  const { deps, calls } = fixture(source(1800));
  const original = deps.acquireWindow;
  deps.acquireWindow = async (...args) => ({ ...await original(...args), bytes: 32 * 1024 * 1024 });
  const result = await researchLongVideo({ ...REQUEST, maxDownloadMB: 32 }, deps);
  assert.equal(result.status, "partial"); assert.equal(calls.acquisitions.length, 1);
  assert.equal(result.processing.download_bytes, 32 * 1024 * 1024);
  assert.deepEqual(result.segments.map((segment) => segment.status), ["complete", "pending", "pending"]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1800 }]);
  assert.match(result.warnings.join(" "), /not processed.*budget/);
  assertAllDisposed(calls);
});

test("each acquisition receives only the remaining cumulative file allowance", async () => {
  const { deps, calls } = fixture(source(1800));
  const original = deps.acquireWindow;
  deps.acquireWindow = async (...args) => ({ ...await original(...args), bytes: 16 * 1024 * 1024 });
  const result = await researchLongVideo({ ...REQUEST, maxDownloadMB: 32 }, deps);
  assert.equal(result.status, "partial"); assert.equal(calls.acquisitions.length, 2);
  assert.deepEqual(calls.acquisitions.map((request) => request.maxAcquiredBytes), [32 * 1024 * 1024, 16 * 1024 * 1024]);
  assert.equal(result.processing.download_bytes, 32 * 1024 * 1024);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 1200, end_seconds: 1800 }]);
  assertAllDisposed(calls);
});

function captionSource(): SourceContext {
  const selected = source(1200);
  selected.captions = { status: "available", kind: "manual", language: "zh", cues: [{ start: 20, end: 30, content: "CAPTION_ONLY_FIRST" }, { start: 620, end: 630, content: "CAPTION_ONLY_SECOND" }] };
  selected.capabilities.captions = { status: "available" }; selected.warnings = [];
  return selected;
}
test("caption-based language research avoids media and distinguishes caption coverage from pixels", async () => {
  const { deps, calls } = fixture(captionSource());
  const result = await researchLongVideo({ ...REQUEST, mode: "language" }, deps);
  assert.equal(result.status, "complete"); assert.equal(calls.acquisitions.length, 0); assert.equal(calls.media.length, 0);
  assert.equal(calls.transcriptions.length, 0); assert.equal(calls.preparations.length, 0);
  assert.ok(result.segments.every((segment) => segment.basis === "captions"));
  assert.ok(result.evidence.filter((item) => item.kind !== "metadata").every((item) => item.kind === "caption"));
  assert.match(calls.text[0], /CAPTION_ONLY_FIRST/); assert.doesNotMatch(calls.text[0], /CAPTION_ONLY_SECOND/);
  assert.match(calls.text[1], /CAPTION_ONLY_SECOND/); assert.doesNotMatch(calls.text[1], /CAPTION_ONLY_FIRST/);
  assert.match(result.coverage.limitations.join(" "), /Caption-only.*not visual coverage/);
});

test("vision research ignores available caption text and asks for silent visual preparations", async () => {
  const { deps, calls } = fixture(captionSource());
  const result = await researchLongVideo({ ...REQUEST, mode: "vision" }, deps);
  assert.equal(result.status, "complete"); assert.equal(calls.acquisitions.length, 2);
  assert.ok(calls.preparations.every((call) => call.mode === "vision"));
  assert.equal(calls.transcriptions.length, 0);
  assert.ok(result.segments.every((segment) => segment.basis === "video"));
  for (const item of result.evidence.filter((item) => item.kind !== "metadata")) {
    assert.equal(item.kind, "visual"); assert.deepEqual(item.data?.channels, ["video"]); assert.equal(item.data?.audio_removed, true);
  }
  assert.doesNotMatch(calls.media.map((call) => call.prompt).join("\n"), /CAPTION_ONLY_/);
  assertAllDisposed(calls);
});

test("missing authorized subtitles use per-window ASR without implying visual inspection", async () => {
  const { deps, calls } = fixture(source(1200));
  const result = await researchLongVideo({ ...REQUEST, mode: "language" }, deps);
  assert.equal(result.status, "complete"); assert.equal(calls.acquisitions.length, 2); assert.equal(calls.transcriptions.length, 2);
  assert.equal(calls.preparations.length, 0); assert.equal(calls.media.length, 0);
  assert.equal(result.capabilities.captions.status, "auth_required");
  assert.ok(result.segments.every((segment) => segment.basis === "audio"));
  assert.ok(result.evidence.filter((item) => item.kind !== "metadata").every((item) => item.kind === "asr" && item.precision === "requested_window"));
  assert.match(result.warnings.join(" "), /authorized session/);
  assertAllDisposed(calls);
});

test("metadata-only and invented evidence IDs cannot become accepted final findings", async () => {
  const { deps, calls } = fixture(source(600));
  const invalid = JSON.stringify({ analysis: "Unverified model answer", findings: [{ statement: "Title proves the method", evidence_ids: ["metadata:1"] }, { statement: "A nonexistent frame proves it", evidence_ids: ["frame:999"] }, { statement: "A mixed invalid citation", evidence_ids: ["overview:1:source", "frame:999"] }] });
  deps.analyzeMedia = async () => invalid; deps.analyzeText = async () => invalid;
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(result.status, "partial"); assert.deepEqual(result.findings, []);
  assert.equal(result.segments[0].status, "partial"); assert.equal(result.coverage.overview_complete, false);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 0, end_seconds: 600 }]);
  assert.match(result.warnings.join(" "), /discarded.*evidence references were invalid|lacked primary/);
  assertAllDisposed(calls);
});

test("synthesis failure retains completed source windows and individual reports", async () => {
  const { deps, calls } = fixture(source(1200));
  deps.analyzeText = async () => { throw Object.assign(new Error("Synthesis unavailable"), { code: "UPSTREAM_ERROR" }); };
  const result = await researchLongVideo(REQUEST, deps);
  assert.equal(result.status, "partial"); assert.equal(result.coverage.overview_complete, true); assert.deepEqual(result.coverage.unreviewed, []);
  assert.equal(result.errors[0].stage, "synthesis"); assert.equal(result.findings.length, 0);
  assert.match(result.analysis ?? "", /no final synthesis.*completed/);
  assert.match(result.analysis ?? "", /overview:1/); assert.match(result.analysis ?? "", /overview:2/);
  assertAllDisposed(calls);
});

test("one hung source window times out independently while later windows continue and its late asset is disposed", { timeout: 5000 }, async (context) => {
  const now = 1_000_000;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { deps, calls } = fixture(source(1800));
  let parentContext!: ExecutionContext, releaseLateAsset!: () => void, announceSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => { announceSecond = resolve; });
  const windowContexts: ExecutionContext[] = [];
  const resolveSource = deps.resolve, acquire = deps.acquireWindow;
  deps.resolve = async (...args) => { parentContext = args[1]; return resolveSource(...args); };
  deps.acquireWindow = async (...args) => {
    const windowContext = args[2];
    windowContexts.push(windowContext);
    assert.equal(windowContext.deadlineMs, Date.now() + 15_000);
    assert.ok(windowContext.deadlineMs < parentContext.deadlineMs);
    const asset = await acquire(...args);
    if (args[1].startSeconds === 600) return new Promise<MediaAsset>((resolve) => {
      releaseLateAsset = () => resolve(asset);
      announceSecond();
    });
    return asset;
  };
  const task = researchLongVideo({ ...REQUEST, windowTimeoutSeconds: 15 }, deps);
  await secondStarted;
  assert.equal(parentContext.deadlineMs, now + 900_000);
  context.mock.timers.tick(14_999);
  await setImmediate();
  assert.equal(windowContexts[1].signal.aborted, false);
  assert.equal(calls.acquisitions.length, 2);
  context.mock.timers.tick(1);
  const result = await task;
  assert.equal(result.status, "partial"); assert.equal(result.plan?.window_timeout_seconds, 15);
  assert.equal(parentContext.signal.aborted, false, "a child timeout must leave the overall request alive");
  assert.equal(windowContexts[1].signal.aborted, true);
  assert.equal(windowContexts[2].signal.aborted, false);
  assert.equal(calls.acquisitions.length, 3); assert.equal(calls.media.length, 2);
  assert.deepEqual(result.segments.map((segment) => segment.status), ["complete", "failed", "complete"]);
  assert.equal(result.segments[1].error, "TIMEOUT");
  assert.deepEqual(result.coverage.overview, [{ start_seconds: 0, end_seconds: 600 }, { start_seconds: 1200, end_seconds: 1800 }]);
  assert.deepEqual(result.coverage.unreviewed, [{ start_seconds: 600, end_seconds: 1200 }]);
  assert.ok(result.segments[0].analysis && result.segments[2].analysis && result.analysis);
  assert.ok(result.errors.some((error) => error.code === "TIMEOUT" && /overview:2.*acquire/.test(error.stage)));
  assert.equal(calls.created.length - calls.disposed.length, 1, "only the unresolved acquisition may remain owned by its promise");
  releaseLateAsset();
  await setImmediate();
  assertAllDisposed(calls);
});

test("a source window deadline never exceeds the remaining parent deadline", async (context) => {
  const now = 1_000_000;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { deps, calls } = fixture(source(600));
  let parentContext!: ExecutionContext;
  const resolveSource = deps.resolve, acquire = deps.acquireWindow;
  deps.resolve = async (...args) => { parentContext = args[1]; return resolveSource(...args); };
  deps.acquireWindow = async (...args) => {
    assert.equal(args[2].deadlineMs, parentContext.deadlineMs);
    assert.equal(args[2].deadlineMs - Date.now(), 5000);
    return acquire(...args);
  };
  const result = await researchLongVideo({ ...REQUEST, timeoutSeconds: 5, windowTimeoutSeconds: 15 }, deps);
  assert.equal(result.status, "complete");
  assert.equal(result.plan?.window_timeout_seconds, 15);
  assert.equal(parentContext.signal.aborted, false);
  assertAllDisposed(calls);
});

test("invalid interval and nonfinite budgets are rejected before resolving source metadata", async () => {
  const invalid: Array<Partial<LongVideoRequest>> = [
    { startSeconds: 30 }, { endSeconds: 60 }, { startSeconds: -1, endSeconds: 60 }, { startSeconds: 30, endSeconds: 30 },
    { startSeconds: Number.NaN, endSeconds: 60 }, { startSeconds: 30, endSeconds: Number.POSITIVE_INFINITY },
    { segmentSeconds: Number.NaN }, { maxSegments: 1.5 }, { maxDetailWindows: 5 }, { detailWindowSeconds: 0 },
    { maxDownloadMB: Number.POSITIVE_INFINITY }, { timeoutSeconds: Number.NaN },
    { windowTimeoutSeconds: 14 }, { windowTimeoutSeconds: 601 }, { windowTimeoutSeconds: Number.NaN }, { windowTimeoutSeconds: 15.5 },
  ];
  for (const arguments_ of invalid) {
    const { deps, calls } = fixture();
    const result = await researchLongVideo({ ...REQUEST, ...arguments_ }, deps);
    assert.equal(result.status, "unavailable", JSON.stringify(arguments_));
    assert.equal(calls.resolves, 0, JSON.stringify(arguments_));
    assert.ok(["INVALID_REQUEST", "INVALID_WINDOW"].includes(result.errors[0].code));
  }
});
