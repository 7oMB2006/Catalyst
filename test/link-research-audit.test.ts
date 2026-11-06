import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LongVideoResult } from "../src/long-video-contracts.js";
import type { NoteResearchResult, XiaohongshuResearchResult } from "../src/note-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { continueLinkResearchTask, getLinkResearchTask, startLinkResearchTask } from "../src/link-research.js";
import { engineHost, MemoryLinkResearchStore, NOTE_URL, QUESTION, VIDEO_ONE, VIDEO_TWO, wire } from "./helpers/link-research-fixtures.js";

async function fixture(operation: (engine: ReturnType<typeof engineHost>, store: MemoryLinkResearchStore) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-link-audit-"));
  try { await operation(engineHost(join(directory, "sessions")), new MemoryLinkResearchStore()); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const request = (urls: string[]) => ({ urls, question: QUESTION, actionTimeoutSeconds: 60, totalTimeoutSeconds: 900, segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0 });

test("fresh note access can recover a recorded restriction without historical errors blocking completed pages", async () => fixture(async (engine, store) => {
  let restrict = true;
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, args, signal)) as XiaohongshuResearchResult;
    if (restrict && name === "analyze_xiaohongshu_note") {
      const note = result.result as NoteResearchResult;
      note.status = result.status = "partial"; note.evidence = []; note.findings = []; note.analysis = null;
      note.capabilities.images = { status: "auth_required" };
      note.errors = result.errors = [{ code: "AUTH_REQUIRED", stage: "acquire", message: "The old source access URL expired.", retryable: false }];
    }
    return result;
  } };
  const stopped = await startLinkResearchTask(request([NOTE_URL]), { host, store });
  assert.equal(stopped.task.status, "needs_attention"); assert.equal(stopped.progress[0].reason, "source_access_restricted");
  restrict = false;
  const recovered = await continueLinkResearchTask(stopped.task.id, { sourceUrls: [{ sourceId: "source:1", url: `${NOTE_URL}?xsec_token=renewed-in-memory-access` }] }, { host, store });
  assert.equal(recovered.task.status, "completed");
  assert.equal(recovered.progress[0].status, "complete"); assert.equal(engine.calls.length, 2);
  assert.equal(recovered.task.actions[0].result?.status, "partial", "the earlier failed pass remains available for inspection");
}));

test("a known later resolution failure keeps earlier source evidence available in the task view", async () => fixture(async (engine, store) => {
  engine.settings.duration = 240; engine.settings.failWindow = (_url, start) => start === 120;
  const initial = await startLinkResearchTask(request([VIDEO_ONE]), { host: engine.host, store });
  assert.equal(initial.task.status, "partial");
  const old = initial.materials[0]; assert.equal(old.kind, "video");
  if (old.kind !== "video") throw new Error("The fixture must have video material.");
  const oldEvidence = wire(old.result.evidence);
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, args, signal)) as LongVideoResult;
    result.status = "unavailable"; result.video = null; result.plan = null; result.segments = []; result.evidence = []; result.findings = []; result.analysis = null;
    result.coverage = { overview: [], detail: [], unreviewed: [], overview_complete: false, limitations: [] };
    result.capabilities.metadata = { status: "auth_required" };
    result.errors = [{ code: "AUTH_REQUIRED", stage: "resolve", message: "The source could not be accessed this time.", retryable: false }];
    return result;
  } };
  const failed = await continueLinkResearchTask(initial.task.id, { maxSteps: 1 }, { host, store });
  assert.equal(failed.task.actions.at(-1)?.state, "recorded");
  assert.equal(failed.task.actions.at(-1)?.result?.status, "unavailable");
  const retained = failed.materials[0]; assert.equal(retained?.kind, "video");
  if (retained?.kind !== "video") throw new Error("Earlier evidence must remain accessible.");
  assert.deepEqual(retained.result.evidence, oldEvidence);
  assert.notEqual(failed.task.status, "completed");
}));

test("a fresh URL can retry an initial known video access failure that created no session", async () => fixture(async (engine, store) => {
  let unavailable = true;
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, args, signal)) as LongVideoResult;
    if (unavailable) {
      result.status = "unavailable"; result.video = null; result.plan = null; result.session = null;
      result.segments = []; result.evidence = []; result.findings = []; result.analysis = null;
      result.coverage = { overview: [], detail: [], unreviewed: [], overview_complete: false, limitations: [] };
      result.capabilities.metadata = { status: "auth_required" };
      result.errors = [{ code: "AUTH_REQUIRED", stage: "resolve", message: "The original access URL expired.", retryable: false }];
    }
    return result;
  } };
  const stopped = await startLinkResearchTask(request([VIDEO_ONE]), { host, store });
  assert.equal(stopped.task.status, "needs_attention"); assert.equal(engine.calls.length, 1);
  unavailable = false;
  const recovered = await continueLinkResearchTask(stopped.task.id, { sourceUrls: [{ sourceId: "source:1", url: VIDEO_ONE + "?access_refresh=transient-value" }] }, { host, store });
  assert.equal(recovered.task.status, "completed"); assert.equal(engine.calls.length, 2);
  assert.equal(recovered.task.actions[1].state, "recorded");
}));

test("a video-note receipt for a short selected interval cannot complete whole-link research", async () => fixture(async (engine, store) => {
  engine.settings.noteIsVideo = true; engine.settings.duration = 240;
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, args, signal)) as XiaohongshuResearchResult;
    const video = result.result as LongVideoResult;
    const plain = video as unknown as Record<string, unknown>;
    for (const key of ["plan", "segments", "session", "coverage"]) delete plain[key];
    video.request.startSeconds = 0; video.request.endSeconds = 15;
    video.evidence = video.evidence.filter(evidence => evidence.kind === "metadata"); video.findings = [];
    return result;
  } };
  const rejected = await startLinkResearchTask(request([NOTE_URL]), { host, store });
  assert.notEqual(rejected.task.status, "completed");
  assert.equal(rejected.task.actions[0].state, "unknown");
}));

test("reloaded receipts cannot substitute foreign evidence under a completed saved source", async () => fixture(async (engine, store) => {
  const finished = await startLinkResearchTask(request([VIDEO_ONE]), { host: engine.host, store });
  assert.equal(finished.task.status, "completed");
  const stored = store.records.get(finished.task.id)!;
  const result = stored.actions[0].result as unknown as LongVideoResult;
  const item = result.evidence.find(evidence => evidence.kind === "asr"); assert.ok(item);
  item.source.video_id = "BV1DTxXzUEvW"; item.source.url = VIDEO_TWO;
  await assert.rejects(getLinkResearchTask(finished.task.id, { store }));
  await assert.rejects(continueLinkResearchTask(finished.task.id, undefined, { store, host: engine.host }));
  assert.equal(engine.calls.length, 1, "invalid stored evidence must fail before more external work");
}));

test("Bilibili evidence cannot substitute a differently cased content ID suffix", async () => fixture(async (engine, store) => {
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, args, signal)) as LongVideoResult;
    const metadata = result.evidence.find(evidence => evidence.kind === "metadata"); assert.ok(metadata);
    metadata.source.video_id = metadata.source.video_id.replace("dPe", "DPe");
    return result;
  } };
  const result = await startLinkResearchTask(request([VIDEO_ONE]), { host, store });
  assert.equal(result.task.actions[0].state, "unknown"); assert.equal(result.task.status, "needs_attention");
  assert.equal(result.materials.length, 0);
}));

test("YouTube evidence IDs retain their case-sensitive source identity", async () => fixture(async (engine, store) => {
  const id = "AbCdEF12345", url = `https://www.youtube.com/watch?v=${id}`;
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, { ...args, url: VIDEO_ONE }, signal)) as LongVideoResult;
    result.request.url = url;
    Object.assign(result.video!, { platform: "youtube", id, sourceUrl: url, canonicalUrl: url }); delete result.video!.partId;
    for (const evidence of result.evidence) {
      Object.assign(evidence.source, { platform: "youtube", video_id: id, url }); delete evidence.source.part_id;
    }
    result.evidence.find(evidence => evidence.kind === "metadata")!.source.video_id = id.toLowerCase();
    return result;
  } };
  const result = await startLinkResearchTask(request([url]), { host, store });
  assert.equal(result.task.actions[0].state, "unknown"); assert.equal(result.task.status, "needs_attention");
  assert.equal(result.materials.length, 0);
}));

test("a structured comparison input-budget failure remains a known unavailable receipt", async () => fixture(async (engine, store) => {
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const result = wire(await engine.host.callTool(name, args, signal));
    if (name === "analyze_long_video_url") {
      const video = result as LongVideoResult;
      video.video!.metadata = { retained_source_context: "x".repeat(1_100_000) };
    }
    return result;
  } };
  const result = await startLinkResearchTask(request([VIDEO_ONE, VIDEO_TWO]), { host, store });
  const comparison = result.task.actions.at(-1)!;
  assert.equal(comparison.tool, "compare_research_materials");
  assert.equal(comparison.state, "recorded"); assert.equal(comparison.result?.status, "unavailable");
  assert.notEqual(result.task.status, "completed"); assert.equal(result.materials.length, 2);
  assert.equal(engine.calls.length, 3);
}));
