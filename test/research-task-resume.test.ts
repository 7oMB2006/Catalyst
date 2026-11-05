import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence, ResearchResult, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoResult } from "../src/long-video-contracts.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { ResearchSessionStore } from "../src/research-session-store.js";
import { startLongVideoResearch, resumeLongVideoResearch } from "../src/research-sessions.js";
import { ResearchTaskStore } from "../src/research-task-store.js";
import { createResearchTask, runResearchTask } from "../src/research-tasks.js";

const QUESTION = "Which attention mechanisms appear in the diagrams?";
const PADDED_QUESTION = ` \t${QUESTION}\n `;
const VIDEO = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const YOUTUBE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

function source(): SourceContext {
  return {
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: VIDEO, canonicalUrl: VIDEO, title: "Attention diagrams", durationSeconds: 240 },
    captions: { status: "absent", kind: "unknown", cues: [] }, comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } }, warnings: [],
  };
}
function answer(prompt: string): string {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const start = prompt.lastIndexOf(marker); assert.notEqual(start, -1);
  const evidence = (JSON.parse(prompt.slice(start + marker.length)) as Evidence[]).find(item => item.kind === "visual");
  assert.ok(evidence);
  return JSON.stringify({ analysis: `Observed diagram in ${evidence.id}.`, findings: [{ statement: "The inspected window contains an attention diagram.", evidence_ids: [evidence.id], limitations: ["Fixture model interpretation"] }], relevance_score: 0 });
}
function dependencies(failSecond = false) {
  const calls = { acquired: [] as Array<[number | undefined, number | undefined]>, media: 0, text: 0 };
  const deps: LongVideoDependencies = {
    resolve: async () => structuredClone(source()),
    acquireWindow: async (_video, request) => {
      calls.acquired.push([request.startSeconds, request.endSeconds]);
      if (failSecond && request.startSeconds === 120) throw Object.assign(new Error("Fixture second window interruption"), { code: "FIXTURE_INTERRUPTED", retryable: false });
      return { path: `/fixture/window-${request.startSeconds}.mp4`, bytes: 1024, width: 854, height: 480, fps: 30, dispose: async () => undefined };
    },
    prepareWindow: async path => ({ path: `${path}.silent`, dispose: async () => undefined }),
    transcribe: async () => { throw new Error("Vision-only fixture must not transcribe."); },
    analyzeMedia: async (_path, prompt) => { calls.media++; return answer(prompt); },
    analyzeText: async prompt => { calls.text++; return answer(prompt); },
  };
  return { calls, deps };
}
function coveredCompanion(): ResearchResult {
  return {
    schema_version: "1.0", status: "complete", video: { platform: "youtube", id: "jNQXAC9IVRw", sourceUrl: YOUTUBE, canonicalUrl: YOUTUBE, title: "Covered companion", durationSeconds: 15 },
    request: { url: YOUTUBE, question: QUESTION, mode: "language", startSeconds: 0, endSeconds: 15 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform: "youtube", video_id: "jNQXAC9IVRw", url: YOUTUBE, origin: "fixture" }, time_range: { start_seconds: 0, end_seconds: 15 }, time_basis: "source", precision: "requested_window", content: "Original companion transcription.", limitations: [] }],
    findings: [], analysis: "Covered companion report.", warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
async function temporary(work: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-padded-session-"));
  const previous = process.env.CATALYST_SESSION_DIR;
  process.env.CATALYST_SESSION_DIR = join(directory, "sessions");
  try { await work(await setup(directory)); }
  finally {
    if (previous === undefined) delete process.env.CATALYST_SESSION_DIR; else process.env.CATALYST_SESSION_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function setup(directory: string) {
  const sessions = new ResearchSessionStore(process.env.CATALYST_SESSION_DIR), initial = dependencies(true);
  const previous = await startLongVideoResearch({ url: VIDEO, question: PADDED_QUESTION, mode: "vision", segmentSeconds: 120, maxDetailWindows: 0 }, { store: sessions, dependencies: initial.deps });
  assert.equal(previous.status, "partial"); assert.ok(previous.session);
  assert.deepEqual(previous.segments.map(segment => segment.status), ["complete", "failed"]);
  assert.equal(previous.request.question, PADDED_QUESTION);
  const input: FollowupPlanRequest = { question: PADDED_QUESTION, materials: [{ kind: "session", session_id: previous.session.id }, { kind: "video", result: coveredCompanion() }], maxActions: 1, videoWindowSeconds: 120, actionTimeoutSeconds: 15 };
  const tasks = new ResearchTaskStore(join(directory, "tasks")), resumed = dependencies();
  return { sessions, tasks, input, previous, resumed };
}

test("a task records a real resumed padded-question session and never redispatches its checkpointed result", async () => temporary(async ({ sessions, tasks, input, previous, resumed }) => {
  let resumes = 0;
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    if (name === "plan_research_followup") {
      assert.equal(args.question, QUESTION);
      return planResearchFollowup({ ...input, question: args.question as string });
    }
    assert.equal(name, "resume_long_video_research"); resumes++;
    return resumeLongVideoResearch(args.session_id as string, { timeoutSeconds: args.timeout_seconds as number, windowTimeoutSeconds: args.window_timeout_seconds as number, maxDownloadMB: args.max_download_mb as number }, { store: sessions, dependencies: resumed.deps, signal });
  } };
  const task = await createResearchTask({ plan: input, totalTimeoutSeconds: 15 }, { store: tasks, host });
  assert.equal(task.request.question, QUESTION); assert.equal(task.plan.next_actions.length, 1);
  assert.equal(task.plan.materials[0].can_resume, true);
  assert.equal(task.plan.next_actions[0].tool, "resume_long_video_research");
  const completed = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store: tasks, host });
  assert.equal(completed.status, "completed"); assert.equal(completed.actions[0].state, "recorded");
  const result = completed.actions[0].result as unknown as LongVideoResult;
  assert.equal(result.request.question, PADDED_QUESTION); assert.equal(result.session?.id, previous.session!.id);
  assert.equal(result.session?.reused_segments, 1); assert.equal(result.session?.processed_segments, 1);
  assert.deepEqual(resumed.calls.acquired, [[120, 240]]); assert.equal(resumed.calls.media, 1);
  assert.deepEqual(result.coverage.unreviewed, []); assert.equal(result.coverage.overview_complete, true);
  assert.deepEqual(result.evidence.filter(item => item.kind === "visual").map(item => item.time_range), [{ start_seconds: 0, end_seconds: 120 }, { start_seconds: 120, end_seconds: 240 }]);
  const saved = await tasks.load(task.id); assert.deepEqual(saved, completed);
  assert.deepEqual(await runResearchTask(task.id, undefined, { store: new ResearchTaskStore(tasks.directory), host }), completed);
  assert.equal(resumes, 1); assert.deepEqual(resumed.calls.acquired, [[120, 240]]);
}));

test("trimming session-question padding does not permit a substantive question change", async () => temporary(async ({ sessions, tasks, input, resumed }) => {
  let resumes = 0;
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    if (name === "plan_research_followup") return planResearchFollowup({ ...input, question: args.question as string });
    assert.equal(name, "resume_long_video_research"); resumes++;
    const result = await resumeLongVideoResearch(args.session_id as string, { timeoutSeconds: args.timeout_seconds as number, windowTimeoutSeconds: args.window_timeout_seconds as number, maxDownloadMB: args.max_download_mb as number }, { store: sessions, dependencies: resumed.deps, signal });
    return { ...result, request: { ...result.request, question: "  What animals appear in the video?  " } };
  } };
  const task = await createResearchTask({ plan: input, totalTimeoutSeconds: 15 }, { store: tasks, host });
  const rejected = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store: tasks, host });
  assert.equal(rejected.status, "needs_attention"); assert.equal(rejected.actions[0].state, "unknown"); assert.equal(rejected.actions[0].result, null);
  await runResearchTask(task.id, undefined, { store: tasks, host }); assert.equal(resumes, 1);
}));
