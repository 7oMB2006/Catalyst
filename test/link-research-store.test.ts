import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LongVideoResult } from "../src/long-video-contracts.js";
import type { LinkResearchAction, LinkResearchTaskRecord } from "../src/link-research-contracts.js";
import type { ResearchTaskRecord } from "../src/research-task-contracts.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";
import { followupPlanRequestSchema } from "../src/followup-plan-schema.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { continueLinkResearchRequestSchema, linkActionKey, linkResearchRequestSchema, parseLinkActionResult, parseLinkResearchTaskRecord } from "../src/link-research-schema.js";
import { AnyResearchTaskStore, LinkResearchTaskStore } from "../src/link-research-store.js";
import { ResearchTaskStore } from "../src/research-task-store.js";

const URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/";
const QUESTION = "这篇教程解释了哪些机制？";
const NOW = "2026-11-06T01:00:00.000Z";
function pending(): LinkResearchTaskRecord {
  const request = linkResearchRequestSchema.parse({ urls: [URL], question: QUESTION });
  return { schema_version: "2", kind: "link_research", id: randomUUID(), revision: 1, created_at: NOW, updated_at: NOW,
    request, sources: [{ id: "source:1", url: URL, kind: "video" }], actions: [], status: "ready",
    budget: { max_actions: request.maxActions, attempted_actions: 0, total_timeout_seconds: request.totalTimeoutSeconds, reserved_timeout_seconds: 0 }, stop_reason: "links_saved" };
}
function videoResult(url = URL): LongVideoResult {
  const id = new globalThis.URL(url).pathname.split("/")[2];
  return { schema_version: "1.0", status: "complete", video: { platform: "bilibili", id, sourceUrl: url, canonicalUrl: url, title: "Tutorial", durationSeconds: 120 },
    request: { url, question: QUESTION, mode: "language", timeoutSeconds: 240 },
    capabilities: { metadata: { status: "available" }, captions: { status: "available" }, media: { status: "not_requested" }, comments: { status: "disabled" } },
    evidence: [{ id: "caption:1", kind: "caption", source: { platform: "bilibili", video_id: id, url, origin: "platform_captions" }, time_range: { start_seconds: 0, end_seconds: 120 }, time_basis: "source", precision: "caption_cue", content: "教程中的原始文字。", limitations: [] }],
    findings: [], analysis: "教程介绍了一个机制。", warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
    session: { id: randomUUID(), revision: 1, created_at: NOW, updated_at: NOW, reused_segments: 0, processed_segments: 1 },
    plan: { strategy: "segmented_overview_then_detail", requested_window: { start_seconds: 0, end_seconds: 120 }, segment_seconds: 600, overview_windows: [{ start_seconds: 0, end_seconds: 120 }], max_detail_windows: 0, detail_window_seconds: 120, max_download_bytes: 128 * 1024 * 1024, window_timeout_seconds: 180 },
    segments: [{ id: "overview:1", phase: "overview", window: { start_seconds: 0, end_seconds: 120 }, status: "complete", basis: "captions", evidence_ids: ["caption:1"], analysis: "这段的机制。" }],
    coverage: { overview: [{ start_seconds: 0, end_seconds: 120 }], detail: [], unreviewed: [], overview_complete: true, limitations: [] } };
}
function recorded(): LinkResearchTaskRecord {
  const record = pending();
  const operation = { source_id: "source:1", tool: "analyze_long_video_url" as const,
    arguments: { url: URL, question: QUESTION, mode: "language", timeout_seconds: 240, save_session: true }, basis: [] };
  const action: LinkResearchAction = { ...operation, key: linkActionKey(operation), index: 0, timeout_seconds: 240, state: "recorded", started_at: NOW, finished_at: NOW, result: videoResult() as unknown as Record<string, unknown>, error: null };
  record.actions.push(action); record.status = "completed"; record.stop_reason = "source_complete";
  record.budget.attempted_actions = 1; record.budget.reserved_timeout_seconds = 240;
  return record;
}
async function temporary(operation: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst link store "));
  try { await operation(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("link input supports one link and original share parameters, with bounded mode-dependent defaults", () => {
  const request = linkResearchRequestSchema.parse({ urls: [URL + "?vd_source=transient-share-parameter"], question: "  " + QUESTION + "  " });
  assert.equal(request.urls.length, 1); assert.equal(request.question, QUESTION); assert.equal(request.maxDetailWindows, 0);
  assert.equal(request.actionTimeoutSeconds, 240); assert.equal(request.totalTimeoutSeconds, 1800);
  assert.equal(linkResearchRequestSchema.parse({ urls: [URL], question: QUESTION, mode: "multimodal" }).maxDetailWindows, 2);
  assert.equal(linkResearchRequestSchema.safeParse({ urls: [URL], question: QUESTION, maxDetailWindows: 1 }).success, false);
  for (const input of [{ urls: [], question: QUESTION }, { urls: ["https://127.0.0.1/private"], question: QUESTION }, { urls: [URL], question: QUESTION, totalTimeoutSeconds: 3601 }, { urls: [URL], question: QUESTION, maxActions: 17 }]) assert.equal(linkResearchRequestSchema.safeParse(input).success, false);
  assert.equal(continueLinkResearchRequestSchema.parse({}).maxSteps, 3);
  assert.equal(continueLinkResearchRequestSchema.safeParse({ maxSteps: 5 }).success, false);
  assert.equal(continueLinkResearchRequestSchema.safeParse({ sourceUrls: [{ sourceId: "source:1", url: URL }, { sourceId: "source:1", url: URL }] }).success, false);
});

test("v2 records require normalized public URLs and exact source/action/budget relationships", () => {
  const valid = recorded(); assert.deepEqual(parseLinkResearchTaskRecord(valid, valid.id), valid);
  const mutations: Array<(record: LinkResearchTaskRecord) => void> = [
    r => { r.request.urls[0] += "?token=private-acquisition-secret"; r.sources[0].url = r.request.urls[0]; },
    r => { r.sources[0].id = "source:2"; }, r => { r.sources[0].kind = "xiaohongshu"; },
    r => { r.budget.reserved_timeout_seconds = 0; }, r => { r.budget.attempted_actions = 0; },
    r => { r.actions[0].index = 1; }, r => { r.actions[0].key = "0".repeat(64); },
    r => { r.actions[0].result = null; }, r => { r.actions[0].finished_at = null; },
    r => { r.actions[0].basis = [0]; r.actions[0].key = linkActionKey(r.actions[0]); },
    r => { r.actions[0].arguments.question = "另一个研究问题"; r.actions[0].key = linkActionKey(r.actions[0]); },
    r => { r.actions[0].arguments.extra_provider_option = "unsupported"; r.actions[0].key = linkActionKey(r.actions[0]); },
    r => { r.actions[0].arguments.timeout_seconds = 120; },
    r => { delete (r.request as unknown as Record<string, unknown>).maxActions; },
  ];
  for (const mutate of mutations) { const altered = structuredClone(valid); mutate(altered); assert.throws(() => parseLinkResearchTaskRecord(altered)); }
  assert.throws(() => parseLinkResearchTaskRecord(valid, randomUUID()));
});

test("missing acknowledgments retain a reserved last attempt and forbid later actions", () => {
  const unknown = recorded();
  Object.assign(unknown.actions[0], { state: "unknown", result: null, error: { code: "OUTCOME_UNKNOWN", message: "The receipt was not confirmed." } });
  unknown.status = "needs_attention";
  assert.deepEqual(parseLinkResearchTaskRecord(unknown), unknown);
  const appended = structuredClone(unknown), next = structuredClone(appended.actions[0]);
  next.index = 1; next.basis = [0]; next.key = linkActionKey(next); appended.actions.push(next);
  appended.budget.attempted_actions++; appended.budget.reserved_timeout_seconds += next.timeout_seconds;
  assert.throws(() => parseLinkResearchTaskRecord(appended));
});

test("fresh-source retries cannot replace completed video work with a new initial read", () => {
  const completed = recorded(), action = structuredClone(completed.actions[0]);
  action.index = 1; action.basis = [0]; action.key = linkActionKey(action);
  completed.actions.push(action); completed.budget.attempted_actions++; completed.budget.reserved_timeout_seconds += action.timeout_seconds;
  assert.throws(() => parseLinkResearchTaskRecord(completed));
});

test("Xiaohongshu result parsing preserves nested long-video state and rejects malformed long state", () => {
  const video = videoResult(), wrapper = { schema_version: "1.0", status: "complete", content_type: "video_note", result: video, errors: [] };
  const parsed = parseLinkActionResult({ tool: "analyze_xiaohongshu_note" }, wrapper);
  assert.deepEqual(parsed.result, video);
  assert.deepEqual((parsed.result as LongVideoResult).segments, video.segments);
  const broken = structuredClone(wrapper); (broken.result as unknown as Record<string, unknown>).segments = "invalid";
  assert.throws(() => parseLinkActionResult({ tool: "analyze_xiaohongshu_note" }, broken));
});

test("private v2 snapshots survive restart, and all stores share the same process lock", async () => temporary(async directory => {
  const store = new LinkResearchTaskStore(directory), snapshot = recorded();
  await store.withLock(snapshot.id, () => store.save(snapshot, null));
  assert.deepEqual(await new LinkResearchTaskStore(directory).load(snapshot.id), snapshot);
  assert.deepEqual(await new AnyResearchTaskStore(directory).load(snapshot.id), snapshot);
  if (process.platform !== "win32") assert.equal((await fs.stat(join(directory, `${snapshot.id}.json`))).mode & 0o777, 0o600);
  await store.withLock(snapshot.id, async () => {
    await assert.rejects(new AnyResearchTaskStore(directory).withLock(snapshot.id, async () => undefined), { code: "TASK_BUSY" });
    await assert.rejects(new ResearchTaskStore(directory).delete(snapshot.id), { code: "TASK_BUSY" });
  });
  const advanced = { ...snapshot, revision: 2 };
  await store.withLock(snapshot.id, () => store.save(advanced, 1));
  await assert.rejects(store.withLock(snapshot.id, () => store.save(advanced, 1)), { code: "TASK_CONFLICT" });
  assert.equal((await new LinkResearchTaskStore(directory).load(snapshot.id)).revision, 2);
}));

test("snapshot sanitization preserves YouTube IDs and Bilibili selected parts in URL arrays", async () => temporary(async directory => {
  const store = new LinkResearchTaskStore(directory);
  for (const url of [`${URL}?p=17`, "https://www.youtube.com/watch?v=AbCdEF12345"]) {
    const snapshot = pending(); snapshot.request.urls = [url + "&token=transient-acquisition-secret"]; snapshot.sources[0].url = snapshot.request.urls[0];
    await store.withLock(snapshot.id, () => store.save(snapshot, null));
    const loaded = await new LinkResearchTaskStore(directory).load(snapshot.id);
    assert.deepEqual(loaded.request.urls, [url]); assert.equal(loaded.sources[0].url, url);
    assert.doesNotMatch(await fs.readFile(join(directory, `${snapshot.id}.json`), "utf8"), /transient-acquisition-secret|token=/);
  }
}));

test("mixed v1 and v2 records remain readable and appear once in unified listing", async () => temporary(async directory => {
  const legacyStore = new ResearchTaskStore(directory), links = new LinkResearchTaskStore(directory), all = new AnyResearchTaskStore(directory);
  const request = followupPlanRequestSchema.parse({ question: QUESTION, materials: [URL, "https://www.bilibili.com/video/BV1dPeP6REwM/"].map(url => ({ kind: "video", result: videoResult(url) })) }) as unknown as FollowupPlanRequest;
  const plan = await planResearchFollowup(request);
  const legacy: ResearchTaskRecord = { schema_version: "1", id: randomUUID(), revision: 1, created_at: NOW, updated_at: NOW, request, plan, selected_keys: null, actions: [], status: "planned", budget: { max_actions: 3, attempted_actions: 0, total_timeout_seconds: 900, reserved_timeout_seconds: 0 }, stop_reason: plan.stop_reason };
  assert.equal(plan.next_actions.length, 0);
  const modern = recorded();
  await legacyStore.withLock(legacy.id, () => legacyStore.save(legacy, null));
  await links.withLock(modern.id, () => links.save(modern, null));
  assert.deepEqual(await legacyStore.list(), [legacy]); assert.deepEqual(await links.list(), [modern]);
  assert.deepEqual(new Set((await all.list()).map(record => record.id)), new Set([legacy.id, modern.id]));
  assert.equal((await all.load(legacy.id)).schema_version, "1"); assert.equal((await all.load(modern.id)).schema_version, "2");
  await all.delete(modern.id); assert.deepEqual(await all.list(), [legacy]);
}));

test("the shared 100-task capacity counts both task formats and preserves invalid files", async () => temporary(async directory => {
  const store = new LinkResearchTaskStore(directory), record = pending();
  await store.withLock(record.id, () => store.save(record, null));
  for (let index = 1; index < 100; index++) await fs.writeFile(join(directory, `${randomUUID()}.json`), "{}");
  const next = pending();
  await assert.rejects(store.withLock(next.id, () => store.save(next, null)), { code: "TASK_LIMIT_REACHED" });
  assert.equal((await fs.readdir(directory)).length, 100);
  assert.deepEqual(await new AnyResearchTaskStore(directory).list(), [record]);
}));
