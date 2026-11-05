import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchResult } from "../src/contracts.js";
import type { NoteResearchResult } from "../src/note-contracts.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";
import type { ResearchTaskHost, ResearchTaskRecord, ResearchTaskStorage } from "../src/research-task-contracts.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { createResearchTask, runResearchTask } from "../src/research-tasks.js";
import { ResearchTaskStore } from "../src/research-task-store.js";

const QUESTION = "What source evidence describes attention?";
const VIDEO = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const YOUTUBE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const NOTE = "https://www.xiaohongshu.com/explore/6ae80a83000000001a0153d3";

function result(url = VIDEO, start = 0, end = 15, status: ResearchResult["status"] = "complete"): ResearchResult {
  const platform = url === VIDEO ? "bilibili" : "youtube";
  const id = platform === "bilibili" ? "BV1DTxXzUEvW" : "jNQXAC9IVRw";
  const part = platform === "bilibili" ? { partId: "38253823575" } : {};
  return {
    schema_version: "1.0", status,
    video: { platform, id, ...part, sourceUrl: url, canonicalUrl: url, title: "Attention source", durationSeconds: 120 },
    request: { url, question: QUESTION, mode: "language", startSeconds: start, endSeconds: end },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: status === "unavailable" ? [] : [{
      id: "asr:1", kind: "asr", source: { platform, video_id: id, ...(part.partId ? { part_id: part.partId } : {}), url, origin: "fixture" },
      time_range: { start_seconds: start, end_seconds: end }, time_basis: "source", precision: "requested_window", content: `Source transcription from ${start} to ${end}.`, limitations: ["Fixture source transcription is unverified."],
    }],
    findings: [], analysis: status === "complete" ? "Fixture bounded source analysis." : null, warnings: [],
    errors: status === "complete" ? [] : [{ code: "UPSTREAM_ERROR", stage: "analysis", message: "Fixture provider failure after acquisition", retryable: true }],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}

function request(): FollowupPlanRequest {
  return { question: QUESTION, materials: [{ kind: "video", result: result() }, { kind: "video", result: result(YOUTUBE) }], coverageTarget: "source", maxActions: 2, maxSources: 2, videoWindowSeconds: 30, actionTimeoutSeconds: 15 };
}
function noteResult(startPage = 1, endPage = 2): NoteResearchResult {
  return {
    schema_version: "1.0", status: "complete",
    note: { platform: "xiaohongshu", id: "6ae80a83000000001a0153d3", sourceUrl: NOTE, canonicalUrl: NOTE, title: "Attention image note", description: "Source body", contentType: "image_note", imageCount: 6 },
    request: { url: NOTE, question: QUESTION, mode: "text", startPage, endPage },
    capabilities: { body: { status: "not_requested" }, images: { status: "available" }, ocr: { status: "available" }, comments: { status: "disabled" } },
    evidence: Array.from({ length: endPage - startPage + 1 }, (_, offset) => ({ id: `ocr:${startPage + offset}`, kind: "image_text", source: { platform: "xiaohongshu", note_id: "6ae80a83000000001a0153d3", url: NOTE, origin: "fixture" }, page: startPage + offset, content: "Original image text", limitations: [] })),
    findings: [], analysis: "Fixture image-note analysis", warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
type Call = { name: string; args: Record<string, unknown>; signal?: AbortSignal };
async function fixture(handler?: (call: Call) => Promise<unknown>, input = request()) {
  const plan = await planResearchFollowup(input), calls: Call[] = [];
  assert.equal(plan.next_actions.length, 2);
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    const call = { name, args: structuredClone(args), signal }; calls.push(call);
    if (name === "plan_research_followup") return structuredClone(plan);
    if (handler) return handler(call);
    return result(args.url as string, args.start_seconds as number, args.end_seconds as number);
  } };
  return { input, plan, host, calls, effects: () => calls.filter((call) => call.name !== "plan_research_followup") };
}
async function temporary(work: (store: ResearchTaskStore, directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-workflow-"));
  try { await work(new ResearchTaskStore(directory), directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function interceptSaves(store: ResearchTaskStorage, before: (record: ResearchTaskRecord) => void): ResearchTaskStorage {
  return {
    newId: () => store.newId(), load: (id) => store.load(id),
    withLock: (id, operation) => store.withLock(id, operation),
    save: async (record, revision) => { before(record); await store.save(record, revision); },
  };
}

test("task creation freezes a plan without executing it and maps host planner arguments", async () => temporary(async (store) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input, totalTimeoutSeconds: 30 }, { store, host: f.host });
  assert.equal(task.status, "planned"); assert.equal(task.selected_keys, null);
  assert.deepEqual(task.actions.map((action) => action.state), ["pending", "pending"]);
  assert.equal(task.budget.attempted_actions, 0); assert.equal(task.budget.reserved_timeout_seconds, 0);
  assert.equal(task.budget.total_timeout_seconds, 30);
  assert.deepEqual(task.plan.next_actions, f.plan.next_actions);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, "plan_research_followup");
  assert.equal(f.calls[0].args.coverage_target, "source"); assert.equal(f.calls[0].args.max_actions, 2);
  assert.equal(f.calls[0].args.video_window_seconds, 30); assert.equal(f.calls[0].args.action_timeout_seconds, 15);
  assert.equal(f.calls[0].args.coverageTarget, undefined);
  assert.deepEqual(await store.load(task.id), task);
}));

test("selected actions run sequentially after durable reservations and preserve new source windows", async () => temporary(async (store) => {
  let id = "", active = 0;
  const f = await fixture(async (call) => {
    active++; assert.equal(active, 1);
    const saved = await store.load(id), running = saved.actions.filter((action) => action.state === "running");
    assert.equal(running.length, 1); assert.ok(saved.selected_keys?.includes(running[0].key));
    assert.equal(saved.budget.attempted_actions, saved.actions.filter((action) => action.state !== "pending").length);
    assert.equal(saved.budget.reserved_timeout_seconds, saved.budget.attempted_actions * 15);
    active--;
    return result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number);
  });
  const task = await createResearchTask({ plan: f.input, totalTimeoutSeconds: 30 }, { store, host: f.host }); id = task.id;
  const selected = task.plan.next_actions.map((action) => action.key), finished = await runResearchTask(id, selected, { store, host: f.host });
  assert.equal(finished.status, "completed"); assert.equal(finished.budget.attempted_actions, 2); assert.equal(finished.budget.reserved_timeout_seconds, 30);
  assert.deepEqual(finished.actions.map((action) => action.state), ["recorded", "recorded"]);
  assert.deepEqual(f.effects().map((call) => call.args.url), [VIDEO, YOUTUBE]);
  assert.deepEqual(f.effects().map((call) => [call.args.start_seconds, call.args.end_seconds]), [[15, 45], [15, 45]]);
  for (const action of finished.actions) {
    const retained = action.result as unknown as ResearchResult;
    assert.deepEqual(retained.evidence[0].time_range, { start_seconds: 15, end_seconds: 45 });
    assert.equal(retained.status, "complete");
  }
  const again = await runResearchTask(id, undefined, { store, host: f.host });
  assert.equal(again.status, "completed"); assert.equal(f.effects().length, 2); assert.deepEqual(again.budget, finished.budget);
}));

test("partial and unavailable research outcomes are recorded once without automatic retry", async (t) => {
  for (const status of ["partial", "unavailable"] as const) await t.test(status, async () => temporary(async (store) => {
    const f = await fixture(async (call) => result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number, status));
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host }), key = task.plan.next_actions[0].key;
    const finished = await runResearchTask(task.id, [key], { store, host: f.host });
    assert.equal(finished.status, "partial"); assert.equal(finished.actions[0].state, "recorded");
    assert.equal(finished.actions[0].result?.status, status); assert.equal(finished.actions[1].state, "pending");
    assert.deepEqual(finished.selected_keys, [key]);
    const restarted = await runResearchTask(task.id, undefined, { store: new ResearchTaskStore(store.directory), host: f.host });
    assert.equal(restarted.status, "partial"); assert.equal(f.effects().length, 1); assert.equal(restarted.budget.attempted_actions, 1);
  }));
});

test("checkpointed success survives failure to reserve the next action and a fresh store resumes only pending work", async () => temporary(async (store, directory) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input, totalTimeoutSeconds: 30 }, { store, host: f.host });
  const faulty = interceptSaves(store, (record) => {
    if (record.actions[0].state === "recorded" && record.actions[1].state === "running") throw new Error("Fixture failure writing second dispatch reservation");
  });
  await assert.rejects(runResearchTask(task.id, task.plan.next_actions.map((action) => action.key), { store: faulty, host: f.host }));
  assert.equal(f.effects().length, 1);
  const checkpoint = await store.load(task.id);
  assert.deepEqual(checkpoint.actions.map((action) => action.state), ["recorded", "pending"]);
  assert.equal(checkpoint.budget.attempted_actions, 1); assert.equal(checkpoint.budget.reserved_timeout_seconds, 15);
  const finished = await runResearchTask(task.id, undefined, { store: new ResearchTaskStore(directory), host: f.host });
  assert.equal(finished.status, "completed"); assert.deepEqual(f.effects().map((call) => call.args.url), [VIDEO, YOUTUBE]);
  assert.equal(finished.budget.attempted_actions, 2); assert.equal(finished.budget.reserved_timeout_seconds, 30);
}));

test("a result whose checkpoint failed leaves an unknown action after restart and is never redispatched", async () => temporary(async (store, directory) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const faulty = interceptSaves(store, (record) => {
    if (record.actions.some((action) => action.state === "recorded")) throw new Error("Fixture result checkpoint failed");
  });
  await assert.rejects(runResearchTask(task.id, task.plan.next_actions.map((action) => action.key), { store: faulty, host: f.host }));
  assert.equal(f.effects().length, 1); assert.equal((await store.load(task.id)).actions[0].state, "running");
  const fresh = new ResearchTaskStore(directory), recovered = await runResearchTask(task.id, undefined, { store: fresh, host: f.host });
  assert.equal(recovered.status, "needs_attention"); assert.deepEqual(recovered.actions.map((action) => action.state), ["unknown", "pending"]);
  assert.equal(recovered.budget.attempted_actions, 1); assert.equal(recovered.budget.reserved_timeout_seconds, 15);
  const again = await runResearchTask(task.id, undefined, { store: fresh, host: f.host });
  assert.equal(again.status, "needs_attention"); assert.equal(f.effects().length, 1); assert.deepEqual(again.budget, recovered.budget);
}));

test("transport loss and malformed tool responses preserve uncertainty and stop remaining actions", async (t) => {
  for (const [name, handler] of [
    ["lost acknowledgement", async () => { throw new Error("Fixture connection closed after dispatch"); }],
    ["invalid structured result", async () => ({ arbitrary: "A tool invocation is not a validated research result." })],
  ] as const) await t.test(name, async () => temporary(async (store) => {
    const f = await fixture(handler), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const interrupted = await runResearchTask(task.id, task.plan.next_actions.map((action) => action.key), { store, host: f.host });
    assert.equal(interrupted.status, "needs_attention"); assert.deepEqual(interrupted.actions.map((action) => action.state), ["unknown", "pending"]);
    assert.ok(interrupted.actions[0].error); assert.equal(interrupted.actions[0].result, null); assert.equal(f.effects().length, 1);
    await runResearchTask(task.id, undefined, { store, host: f.host }); assert.equal(f.effects().length, 1);
  }));
});

test("cancellation bounds an uncooperative host call and never replays its unknown outcome", { timeout: 10_000 }, async () => temporary(async (store) => {
  const controller = new AbortController();
  const f = await fixture(async (call) => {
    assert.ok(call.signal); queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  });
  const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const interrupted = await runResearchTask(task.id, task.plan.next_actions.map((action) => action.key), { store, host: f.host, signal: controller.signal });
  assert.equal(interrupted.status, "needs_attention"); assert.equal(interrupted.actions[0].state, "unknown");
  assert.equal(interrupted.budget.attempted_actions, 1); assert.equal(f.effects().length, 1);
  await runResearchTask(task.id, undefined, { store, host: f.host }); assert.equal(f.effects().length, 1);
}));

test("schema-valid results cannot claim completion for another source, window, mode or question", async (t) => {
  const mismatches: Array<[string, (call: Call) => ResearchResult]> = [
    ["foreign source", (call) => result(YOUTUBE, call.args.start_seconds as number, call.args.end_seconds as number)],
    ["different window", (call) => result(call.args.url as string, 45, 75)],
    ["different mode", (call) => { const output = result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number); output.request.mode = "vision"; return output; }],
    ["different question", (call) => { const output = result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number); output.request.question = "A different research question"; return output; }],
  ];
  for (const [name, response] of mismatches) await t.test(name, async () => temporary(async (store) => {
    const f = await fixture(async (call) => response(call)), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const interrupted = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
    assert.equal(interrupted.status, "needs_attention"); assert.equal(interrupted.actions[0].state, "unknown");
    assert.equal(interrupted.actions[0].result, null); assert.equal(f.effects().length, 1);
    await runResearchTask(task.id, undefined, { store, host: f.host }); assert.equal(f.effects().length, 1);
  }));
});

test("an unresolved complete result cannot be recorded as completed research", async (t) => {
  await t.test("video with no resolved source", async () => temporary(async (store) => {
    const f = await fixture(async (call) => {
      const output = result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number);
      output.video = null; output.evidence = []; return output;
    });
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const interrupted = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
    assert.equal(interrupted.status, "needs_attention"); assert.equal(interrupted.actions[0].state, "unknown");
    assert.equal(interrupted.actions[0].result, null); assert.equal(f.effects().length, 1);
  }));
  await t.test("Xiaohongshu wrapper with no research leaf", async () => temporary(async (store) => {
    const input = request(); input.materials[1] = { kind: "note", result: noteResult() };
    const f = await fixture(async () => ({ schema_version: "1.0", status: "complete", content_type: "image_note", result: null, errors: [] }), input);
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const index = task.plan.next_actions.findIndex((action) => action.tool === "analyze_xiaohongshu_note"); assert.ok(index >= 0);
    const interrupted = await runResearchTask(task.id, [task.plan.next_actions[index].key], { store, host: f.host });
    assert.equal(interrupted.status, "needs_attention"); assert.equal(interrupted.actions[index].state, "unknown");
    assert.equal(interrupted.actions[index].result, null); assert.equal(f.effects().length, 1);
  }));
});

test("a known Bilibili CID must remain bound even when the BV and canonical part URL match", async () => temporary(async (store) => {
  const f = await fixture(async (call) => {
    const output = result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number);
    output.video!.partId = "99999999999";
    for (const item of output.evidence) item.source.part_id = "99999999999";
    return output;
  });
  const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const interrupted = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
  assert.equal(interrupted.status, "needs_attention"); assert.equal(interrupted.actions[0].state, "unknown");
  assert.equal(interrupted.actions[0].result, null); assert.equal(f.effects().length, 1);
}));

test("a previously unknown Bilibili CID can be supplied by successful source resolution", async () => temporary(async (store) => {
  const input = request(), seed = (input.materials[0] as { kind: "video"; result: ResearchResult }).result;
  delete seed.video!.partId;
  for (const item of seed.evidence) delete item.source.part_id;
  const f = await fixture(undefined, input), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const finished = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
  assert.equal(finished.status, "completed"); assert.equal(finished.actions[0].state, "recorded");
  assert.equal((finished.actions[0].result as unknown as ResearchResult).video?.partId, "38253823575");
}));

test("caption cue results are not constrained by the comparison excerpt budget", async (t) => {
  for (const foreign of [false, true]) await t.test(foreign ? "foreign cue remains invalid among eighty-one cues" : "eighty-one valid cues are retained", async () => temporary(async (store) => {
    const f = await fixture(async (call) => {
      const start = call.args.start_seconds as number, end = call.args.end_seconds as number;
      const output = result(call.args.url as string, start, end), template = output.evidence[0];
      output.capabilities.captions = { status: "available" };
      output.evidence = Array.from({ length: 81 }, (_, index) => ({
        ...structuredClone(template), id: `caption:${index + 1}`, kind: "caption", precision: "caption_cue",
        time_range: { start_seconds: start + (end - start) * index / 81, end_seconds: start + (end - start) * (index + 1) / 81 },
        content: `Source caption cue ${index + 1}`,
      }));
      if (foreign) output.evidence[40].source.video_id = "BV1xx411c7mD";
      return output;
    });
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const output = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
    if (foreign) {
      assert.equal(output.status, "needs_attention"); assert.equal(output.actions[0].state, "unknown"); assert.equal(output.actions[0].result, null);
    } else {
      assert.equal(output.status, "completed"); assert.equal(output.actions[0].state, "recorded");
      assert.equal((output.actions[0].result as unknown as ResearchResult).evidence.length, 81);
    }
    assert.equal(f.effects().length, 1);
  }));
});

test("unresolved results still require the selected mode and window while unavailable responses can be retained", async (t) => {
  for (const change of ["mode", "window", "source URL"] as const) await t.test(`unresolved partial with different ${change}`, async () => temporary(async (store) => {
    const f = await fixture(async (call) => {
      const output = result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number, "partial");
      output.video = null; output.evidence = [];
      if (change === "mode") output.request.mode = "vision";
      else if (change === "window") { output.request.startSeconds = 45; output.request.endSeconds = 75; }
      else output.request.url = YOUTUBE;
      return output;
    });
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const interrupted = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
    assert.equal(interrupted.status, "needs_attention"); assert.equal(interrupted.actions[0].state, "unknown");
  }));
  await t.test("unavailable video with no resolved source", async () => temporary(async (store) => {
    const f = await fixture(async (call) => {
      const output = result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number, "unavailable");
      output.video = null; return output;
    });
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const finished = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host });
    assert.equal(finished.status, "partial"); assert.equal(finished.actions[0].state, "recorded"); assert.equal(finished.actions[0].result?.status, "unavailable");
  }));
  await t.test("unavailable Xiaohongshu wrapper with no research leaf", async () => temporary(async (store) => {
    const input = request(); input.materials[1] = { kind: "note", result: noteResult() };
    const f = await fixture(async () => ({ schema_version: "1.0", status: "unavailable", content_type: "unknown", result: null, errors: [{ code: "UPSTREAM_ERROR", stage: "source", message: "Source resolution failed", retryable: true }] }), input);
    const task = await createResearchTask({ plan: f.input }, { store, host: f.host });
    const index = task.plan.next_actions.findIndex((action) => action.tool === "analyze_xiaohongshu_note"); assert.ok(index >= 0);
    const finished = await runResearchTask(task.id, [task.plan.next_actions[index].key], { store, host: f.host });
    assert.equal(finished.status, "partial"); assert.equal(finished.actions[index].state, "recorded"); assert.equal(finished.actions[index].result?.status, "unavailable");
  }));
});

test("pre-cancelled first execution consumes no action or timeout allowance", async () => temporary(async (store) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host: f.host, signal: controller.signal }));
  const retained = await store.load(task.id);
  assert.equal(retained.budget.attempted_actions, 0); assert.equal(retained.budget.reserved_timeout_seconds, 0);
  assert.deepEqual(retained.actions.map((action) => action.state), ["pending", "pending"]); assert.equal(f.effects().length, 0);
}));

test("the persistent total timeout allowance cannot reset on a new invocation", async () => temporary(async (store, directory) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input, totalTimeoutSeconds: 15 }, { store, host: f.host });
  const stopped = await runResearchTask(task.id, task.plan.next_actions.map((action) => action.key), { store, host: f.host });
  assert.equal(stopped.status, "budget_exhausted"); assert.deepEqual(stopped.actions.map((action) => action.state), ["recorded", "pending"]);
  assert.equal(stopped.budget.reserved_timeout_seconds, 15); assert.equal(stopped.budget.attempted_actions, 1); assert.equal(f.effects().length, 1);
  const again = await runResearchTask(task.id, undefined, { store: new ResearchTaskStore(directory), host: f.host });
  assert.equal(again.status, "budget_exhausted"); assert.equal(f.effects().length, 1); assert.deepEqual(again.budget, stopped.budget);
}));

test("selection accepts only explicit unique frozen action keys and never changes a previous selection", async () => temporary(async (store) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const first = task.plan.next_actions[0].key, second = task.plan.next_actions[1].key;
  for (const keys of [undefined, [], ["f".repeat(64)], [first, first]]) {
    await assert.rejects(runResearchTask(task.id, keys, { store, host: f.host }));
    assert.equal(f.effects().length, 0); assert.equal((await store.load(task.id)).selected_keys, null);
  }
  await runResearchTask(task.id, [first], { store, host: f.host });
  await assert.rejects(runResearchTask(task.id, [second], { store, host: f.host }));
  assert.equal(f.effects().length, 1); assert.deepEqual((await store.load(task.id)).selected_keys, [first]);
}));

test("failure to save the first dispatch reservation performs no research call", async () => temporary(async (store) => {
  const f = await fixture(), task = await createResearchTask({ plan: f.input }, { store, host: f.host });
  const faulty = interceptSaves(store, (record) => { if (record.actions.some((action) => action.state === "running")) throw new Error("Fixture reservation write failed"); });
  await assert.rejects(runResearchTask(task.id, [task.plan.next_actions[0].key], { store: faulty, host: f.host }));
  assert.equal(f.effects().length, 0); assert.equal((await store.load(task.id)).budget.attempted_actions, 0);
}));

test("concurrent task execution is rejected while the first host call owns the task lock", { timeout: 10_000 }, async () => temporary(async (store) => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(async (call) => { entered(); await gate; return result(call.args.url as string, call.args.start_seconds as number, call.args.end_seconds as number); });
  const task = await createResearchTask({ plan: f.input }, { store, host: f.host }), keys = [task.plan.next_actions[0].key];
  const first = runResearchTask(task.id, keys, { store, host: f.host });
  try { await started; await assert.rejects(runResearchTask(task.id, keys, { store, host: f.host })); assert.equal(f.effects().length, 1); }
  finally { release(); await first; }
}));

test("invalid creation input and a pre-cancelled creation never call the host", async () => temporary(async (store) => {
  const f = await fixture();
  for (const input of [
    { plan: { ...f.input, materials: f.input.materials.slice(0, 1) } },
    { plan: f.input, totalTimeoutSeconds: 0 },
    { plan: { ...f.input, question: "x".repeat(2 * 1024 * 1024 + 1) } },
  ]) await assert.rejects(createResearchTask(input, { store, host: f.host }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createResearchTask({ plan: f.input }, { store, host: f.host, signal: controller.signal }));
  assert.equal(f.calls.length, 0);
}));
