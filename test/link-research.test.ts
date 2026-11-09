import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonInput } from "../src/comparison-contracts.js";
import type { LongVideoResult } from "../src/long-video-contracts.js";
import type { NoteResearchResult } from "../src/note-contracts.js";
import type { LinkResearchTaskOptions, LinkResearchTaskView } from "../src/link-research-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { startLinkResearchTask, continueLinkResearchTask, getLinkResearchTask } from "../src/link-research.js";
import { engineHost, MemoryLinkResearchStore, NOTE_URL, QUESTION, VIDEO_ONE, VIDEO_TWO, wire } from "./helpers/link-research-fixtures.js";

async function fixture(work: (value: ReturnType<typeof engineHost> & { store: MemoryLinkResearchStore; options: LinkResearchTaskOptions }) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-link-research-"));
  const store = new MemoryLinkResearchStore(), engine = engineHost(join(directory, "sessions"));
  try { await work({ ...engine, store, options: { store, host: engine.host } }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const request = (urls = [VIDEO_ONE]) => ({ urls, question: QUESTION, mode: "language" as const, actionTimeoutSeconds: 60, totalTimeoutSeconds: 900, segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0 });
function video(view: LinkResearchTaskView, index = 0): LongVideoResult {
  const material = view.materials[index]; assert.equal(material?.kind, "video");
  return (material as Extract<ComparisonInput, { kind: "video" }>).result as LongVideoResult;
}
function note(view: LinkResearchTaskView): NoteResearchResult {
  const material = view.materials[0]; assert.equal(material?.kind, "note");
  return (material as Extract<ComparisonInput, { kind: "note" }>).result;
}

test("one link produces a saved native answer; reading and continuing a completed task make no tool calls", async () => fixture(async ({ store, options, calls, windows }) => {
  const completed = await startLinkResearchTask(request(), options);
  assert.equal(completed.task.schema_version, "2"); assert.equal(completed.task.status, "completed");
  assert.equal(completed.progress.length, 1); assert.equal(completed.progress[0].status, "complete"); assert.equal(completed.progress[0].can_continue, false);
  assert.equal(completed.materials.length, 1); assert.match(video(completed).analysis ?? "", /delegates execution/);
  assert.deepEqual(video(completed).coverage.unreviewed, []); assert.equal(completed.comparison, null);
  assert.deepEqual(calls.map(call => call.name), ["analyze_long_video_url"]);
  assert.deepEqual(windows.map(window => [window.start, window.end]), [[0, 120]]);
  const durable = await getLinkResearchTask(completed.task.id, { store: new MemoryLinkResearchStore(store.records) });
  assert.deepEqual(durable, completed);
  const continued = await continueLinkResearchTask(completed.task.id, undefined, { ...options, store: new MemoryLinkResearchStore(store.records) });
  assert.deepEqual(continued, completed); assert.equal(calls.length, 1);
}));

test("two links automatically produce a current comparison whose citations retain each source identity", async () => fixture(async ({ options, calls, comparisons }) => {
  const view = await startLinkResearchTask(request([VIDEO_ONE, VIDEO_TWO]), options);
  assert.equal(view.task.status, "completed"); assert.equal(view.progress.every(source => source.status === "complete"), true);
  assert.deepEqual(calls.map(call => call.name), ["analyze_long_video_url", "analyze_long_video_url", "compare_research_materials"]);
  assert.equal(comparisons.length, 1); assert.equal(comparisons[0].length, 2);
  assert.equal(view.comparison_current, true); assert.ok(view.comparison);
  assert.equal(view.comparison.status, "complete"); assert.equal(view.comparison.source_independence, "not_established");
  assert.equal(view.comparison.comparisons[0].relation, "shared");
  const evidence = new Map(view.comparison.evidence.map(item => [item.id, item]));
  const citedSources = new Set<string>();
  for (const position of view.comparison.comparisons[0].positions) for (const citation of position.citations) {
    const item = evidence.get(citation.evidence_id); assert.ok(item);
    assert.equal(item.material_id, position.material_id); assert.ok(item.content.includes(citation.quote)); citedSources.add(item.locator.url);
  }
  assert.deepEqual([...citedSources].sort(), [VIDEO_ONE, VIDEO_TWO].sort());
  assert.equal(view.task.budget.attempted_actions, 3); assert.equal(view.task.budget.reserved_timeout_seconds, 180, "comparison uses the same persistent allowance as source reading");
}));

test("cancellation after a committed source receipt leaves the next link pending and resumes without rereading", async () => fixture(async ({ store, options, calls, windows }) => {
  const controller = new AbortController();
  store.afterSave = record => {
    if (record.actions.length === 1 && record.actions[0].state === "recorded") controller.abort(new DOMException("Stop between sources", "AbortError"));
  };
  const stopped = await startLinkResearchTask(request([VIDEO_ONE, VIDEO_TWO]), { ...options, signal: controller.signal });
  assert.equal(stopped.task.status, "cancelled"); assert.equal(stopped.task.actions[0].state, "recorded");
  assert.deepEqual(stopped.progress.map(source => source.status), ["complete", "pending"]);
  assert.equal(calls.length, 1);
  const resumedStore = new MemoryLinkResearchStore(store.records);
  const completed = await continueLinkResearchTask(stopped.task.id, { maxSteps: 2 }, { ...options, store: resumedStore });
  assert.equal(completed.task.status, "completed"); assert.equal(completed.comparison_current, true);
  assert.deepEqual(calls.map(call => call.name), ["analyze_long_video_url", "analyze_long_video_url", "compare_research_materials"]);
  assert.deepEqual(windows.map(window => window.url), [VIDEO_ONE, VIDEO_TWO]);
}));

test("a known partial long-video receipt resumes its real saved session and acquires only unread windows", async () => fixture(async ({ options, settings, calls, windows }) => {
  settings.duration = 240; settings.failWindow = (_url, start) => start === 120;
  const partial = await startLinkResearchTask(request(), options);
  assert.equal(partial.task.status, "partial"); assert.equal(partial.task.actions.length, 1, "one source is attempted only once per invocation");
  assert.equal(partial.progress[0].can_continue, true);
  const first = video(partial); assert.ok(first.session);
  assert.deepEqual(first.segments.map(segment => segment.status), ["complete", "failed"]);
  const original = structuredClone(first.evidence.find(item => item.kind === "asr" && item.time_range?.start_seconds === 0)); assert.ok(original);
  settings.failWindow = () => false;
  const complete = await continueLinkResearchTask(partial.task.id, { maxSteps: 1 }, options);
  assert.equal(complete.task.status, "completed"); assert.equal(video(complete).session?.id, first.session.id);
  assert.equal(video(complete).session?.reused_segments, 1); assert.deepEqual(video(complete).coverage.unreviewed, []);
  assert.deepEqual(video(complete).evidence.find(item => item.id === original.id), original, "completed evidence survives unchanged across the actual session resume");
  assert.deepEqual(windows.map(window => [window.start, window.end]), [[0, 120], [120, 240], [120, 240]]);
  assert.deepEqual(calls.map(call => call.name), ["analyze_long_video_url", "resume_long_video_research"]);
  assert.equal(complete.task.budget.attempted_actions, 2); assert.equal(complete.task.budget.reserved_timeout_seconds, 120);
}));

test("a Xiaohongshu video-note wrapper retains its long-video session and resumes beyond the generic 900-second limit", async () => fixture(async ({ options, settings, calls, windows }) => {
  settings.noteIsVideo = true; settings.duration = 960; settings.failWindow = (_url, start) => start === 120;
  const first = await startLinkResearchTask({ ...request([NOTE_URL]), maxSegments: 24 }, options);
  assert.equal(first.task.status, "partial"); assert.equal(first.progress[0].can_continue, true);
  assert.equal(video(first).video?.platform, "xiaohongshu"); assert.equal(video(first).video?.durationSeconds, 960); assert.ok(video(first).session);
  assert.equal(video(first).segments.length, 8); assert.equal(first.task.actions[0].tool, "analyze_xiaohongshu_note");
  const before = windows.length; settings.failWindow = () => false;
  const complete = await continueLinkResearchTask(first.task.id, { maxSteps: 1 }, options);
  assert.equal(complete.task.status, "completed"); assert.deepEqual(video(complete).coverage.unreviewed, []);
  assert.equal(video(complete).session?.id, video(first).session?.id);
  assert.deepEqual(windows.slice(before).map(window => [window.start, window.end]), [[120, 240]]);
  assert.deepEqual(calls.map(call => call.name), ["analyze_xiaohongshu_note", "resume_long_video_research"]);
}));

test("partial note continuation retains old pages and per-pass answers with collision-free references", async () => fixture(async ({ options, settings, calls, notePages }) => {
  settings.missingNotePages = [2, 3];
  const partial = await startLinkResearchTask(request([NOTE_URL]), options);
  assert.equal(partial.task.status, "partial"); assert.equal(partial.progress[0].can_continue, true);
  const first = note(partial), original = structuredClone(first.evidence.find(item => item.page === 1)); assert.ok(original);
  assert.deepEqual(notePages, [[1, 2, 3]]);
  settings.missingNotePages = [];
  const complete = await continueLinkResearchTask(partial.task.id, { maxSteps: 1 }, options);
  assert.equal(complete.task.status, "completed");
  const aggregate = note(complete);
  assert.deepEqual(notePages, [[1, 2, 3], [2, 3]], "only original missing page numbers are acquired again");
  const retained = aggregate.evidence.find(item => item.page === 1 && item.kind === original.kind); assert.ok(retained);
  assert.equal(retained.content, original.content); assert.deepEqual(retained.source, original.source); assert.deepEqual(retained.limitations, original.limitations);
  const originalReceipt = complete.task.actions[0].result?.result as NoteResearchResult;
  assert.deepEqual(originalReceipt.evidence.find(item => item.id === original.id), original, "the exact original page evidence also remains in its immutable pass receipt");
  assert.deepEqual(aggregate.evidence.filter(item => item.kind === "image_text").map(item => item.page).sort(), [1, 2, 3]);
  const evidence = new Set(aggregate.evidence.map(item => item.id));
  assert.equal(evidence.size, aggregate.evidence.length); assert.equal(new Set(aggregate.findings.map(item => item.id)).size, aggregate.findings.length);
  assert.ok(aggregate.findings.length >= 2, "cited findings from both reading passes remain inspectable");
  for (const finding of aggregate.findings) assert.ok(finding.evidence_ids.every(id => evidence.has(id)));
  assert.ok(aggregate.analysis?.includes("The inspected material on page 1 delegates work."));
  assert.ok(aggregate.analysis?.includes("The inspected material on page 2 delegates work."));
  assert.ok(originalReceipt.analysis && aggregate.analysis?.includes(originalReceipt.analysis), "the original pass answer assembled from accepted findings survives continuation");
  assert.match([...aggregate.warnings, ...complete.limitations].join("\n"), /(?:pass|synthesi|分次|逐次|综合)/i, "per-pass reports must not silently claim a new whole-note synthesis");
  assert.equal(aggregate.request.startPage, undefined); assert.equal(aggregate.request.endPage, undefined);
  assert.equal(calls.filter(call => call.name === "analyze_xiaohongshu_note").length, 2);
}));

test("comparison becomes stale after added evidence, and a known synthesis failure cannot mark it current", async () => fixture(async ({ options, settings, calls, comparisons }) => {
  settings.duration = 240; settings.failWindow = (url, start) => url === VIDEO_ONE && start === 120;
  const first = await startLinkResearchTask(request([VIDEO_ONE, VIDEO_TWO]), options);
  assert.equal(first.task.status, "partial"); assert.ok(first.comparison); assert.equal(first.comparison_current, true);
  const firstEvidence = video(first).evidence.filter(item => item.kind === "asr").length;
  settings.failWindow = () => false;
  const added = await continueLinkResearchTask(first.task.id, { maxSteps: 1 }, options);
  assert.equal(video(added).evidence.filter(item => item.kind === "asr").length, firstEvidence + 1);
  assert.equal(added.comparison_current, false); assert.equal(comparisons.length, 1, "the source step limit cannot hide another synthesis call");
  settings.failComparison = true;
  const failed = await continueLinkResearchTask(first.task.id, { maxSteps: 1 }, options);
  assert.equal(failed.comparison_current, false); assert.notEqual(failed.task.status, "completed");
  const receipt = failed.task.actions.at(-1)!;
  assert.equal(receipt.tool, "compare_research_materials"); assert.equal(receipt.state, "recorded", "a structured unavailable comparison is known, rather than a missing acknowledgement");
  assert.equal(receipt.result?.status, "unavailable"); assert.equal(comparisons.length, 2);
  assert.equal(calls.length, 5); assert.equal(failed.task.budget.attempted_actions, 5); assert.equal(failed.task.budget.reserved_timeout_seconds, 300);
}));

test("original signed share URLs reach initial acquisition in memory and never enter durable task snapshots", async () => fixture(async ({ store, options, resolutions }) => {
  const signed = `${NOTE_URL}?xsec_token=fixture-private-access-token&xsec_source=app_share`;
  const view = await startLinkResearchTask(request([signed]), options);
  assert.equal(view.task.status, "completed"); assert.equal(resolutions[0], signed);
  const saved = await store.load(view.task.id);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-private|xsec_token|xsec_source/);
  assert.equal(saved.sources[0].url, NOTE_URL);
  const read = await getLinkResearchTask(view.task.id, { store });
  assert.doesNotMatch(JSON.stringify(read), /fixture-private|xsec_token|xsec_source/);
}));

test("missing acknowledgement stops later sources and a new invocation never replays the unknown action", async () => fixture(async ({ store, options, calls }) => {
  let dispatches = 0;
  const host: ResearchTaskHost = { callTool: async () => { dispatches++; throw new Error("Fixture lost tool acknowledgement"); } };
  const unknown = await startLinkResearchTask(request([VIDEO_ONE, VIDEO_TWO]), { ...options, host });
  assert.equal(unknown.task.status, "needs_attention"); assert.equal(unknown.task.actions.length, 1); assert.equal(unknown.task.actions[0].state, "unknown");
  assert.equal(unknown.task.actions[0].result, null); assert.equal(unknown.task.budget.reserved_timeout_seconds, 60);
  const resumed = await continueLinkResearchTask(unknown.task.id, undefined, { host, store: new MemoryLinkResearchStore(store.records) });
  assert.deepEqual(resumed, unknown); assert.equal(dispatches, 1); assert.equal(calls.length, 0);
}));

test("failure to save a returned result leaves durable dispatch intent and recovery refuses to replay", async () => fixture(async ({ store, options, calls }) => {
  store.failSave = record => record.actions.some(action => action.state === "recorded");
  await assert.rejects(startLinkResearchTask(request(), options));
  assert.equal(store.records.size, 1);
  const saved = [...store.records.values()][0]; assert.equal(saved.actions[0].state, "running"); assert.equal(calls.length, 1);
  const fresh = new MemoryLinkResearchStore(store.records);
  const recovered = await continueLinkResearchTask(saved.id, undefined, { ...options, store: fresh });
  assert.equal(recovered.task.status, "needs_attention"); assert.equal(recovered.task.actions[0].state, "unknown");
  assert.equal(recovered.task.budget.reserved_timeout_seconds, saved.budget.reserved_timeout_seconds); assert.equal(calls.length, 1);
}));

test("a new invocation preserves exhausted allowance and never turns continuation into a fresh budget", async () => fixture(async ({ store, options, calls }) => {
  const stopped = await startLinkResearchTask({ ...request([VIDEO_ONE, VIDEO_TWO]), totalTimeoutSeconds: 60 }, options);
  assert.equal(stopped.task.status, "budget_exhausted"); assert.equal(stopped.task.actions.length, 1); assert.equal(calls.length, 1);
  assert.deepEqual(stopped.progress.map(source => source.status), ["complete", "pending"]);
  const resumed = await continueLinkResearchTask(stopped.task.id, { maxSteps: 4 }, { ...options, store: new MemoryLinkResearchStore(store.records) });
  assert.equal(resumed.task.status, "budget_exhausted"); assert.equal(calls.length, 1);
  assert.equal(resumed.task.budget.total_timeout_seconds, 60); assert.equal(resumed.task.budget.reserved_timeout_seconds, 60);
  assert.equal(resumed.task.budget.attempted_actions, 1);
}));

test("a structured receipt for another source or research question is stopped as an unconfirmed outcome", async (t) => {
  for (const wrong of ["source", "question"] as const) await t.test(wrong, async () => fixture(async ({ options, calls }) => {
    const original = options.host!;
    const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
      const result = wire(await original.callTool(name, wrong === "source" ? { ...args, url: VIDEO_TWO } : args, signal)) as LongVideoResult;
      if (wrong === "question") result.request.question = "A substantively different research question.";
      return result;
    } };
    const rejected = await startLinkResearchTask(request(), { ...options, host });
    assert.equal(rejected.task.status, "needs_attention"); assert.equal(rejected.task.actions[0].state, "unknown"); assert.equal(rejected.materials.length, 0);
    await continueLinkResearchTask(rejected.task.id, undefined, { ...options, host }); assert.equal(calls.length, 1);
  }));
});
