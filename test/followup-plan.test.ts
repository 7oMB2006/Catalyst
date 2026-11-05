import assert from "node:assert/strict";
import test from "node:test";
import type { ComparisonInput } from "../src/comparison-contracts.js";
import type { DiscoveryResult } from "../src/discovery-contracts.js";
import type { FollowupPlanDependencies, FollowupPlanRequest, FollowupPlanResult, PlanningMaterial } from "../src/followup-plan-contracts.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { followupPlanResultSchema } from "../src/followup-plan-schema.js";
import { discoveryRequestSchema } from "../src/discovery-schema.js";

const QUESTION = "这些材料如何描述 Agent 与工具的职责分工？";
const VIDEO = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const NOTE = "https://www.xiaohongshu.com/explore/6ae80a83000000001a0153d3";
const SESSION = "104c897f-7826-43e1-be1b-969fbf6d35bc";
const INPUT: ComparisonInput = { kind: "session", session_id: SESSION };
const REQUEST: FollowupPlanRequest = { question: QUESTION, materials: [INPUT] };

function video(extra: Partial<PlanningMaterial> = {}): PlanningMaterial {
  return {
    id: "material:1", source_key: "bilibili:video:BV1DTxXzUEvW:part:38253823575", url: VIDEO,
    family: "video", original_mode: "language", source_status: "partial", eligible: true,
    requested_window: { start_seconds: 0, end_seconds: 15 }, duration_seconds: 169,
    requested_pages: null, image_count: null,
    language_windows: [{ start_seconds: 0, end_seconds: 15 }], visual_windows: [], language_pages: [], visual_pages: [],
    evidence_ids: ["material:1:text:asr1"], visual_question_changed: false, session_id: null, can_resume: false,
    access: "not_checked", errors: [], limitations: ["Only the supplied source interval is available; ASR is unverified."], ...extra,
  };
}
function note(extra: Partial<PlanningMaterial> = {}): PlanningMaterial {
  return video({ id: "material:2", source_key: "xiaohongshu:note:6ae80a83000000001a0153d3", url: NOTE,
    family: "note", requested_window: null, duration_seconds: null, requested_pages: { start_page: 1, end_page: 8 }, image_count: 8,
    language_windows: [], visual_windows: [], language_pages: [1, 2, 5, 7, 8], visual_pages: [], evidence_ids: ["material:2:text:page1", "material:2:text:page2", "material:2:text:page5", "material:2:text:page7", "material:2:text:page8"], ...extra });
}
function fixture(materials: PlanningMaterial[] = [video()]) {
  const calls = { count: 0 };
  const dependencies: FollowupPlanDependencies = { prepare: async () => { calls.count++; return structuredClone(materials); } };
  return { calls, dependencies };
}
function request(extra: Partial<FollowupPlanRequest> = {}): FollowupPlanRequest { return { ...REQUEST, ...extra }; }
function assertContract(result: FollowupPlanResult): void {
  const parsed = followupPlanResultSchema.safeParse(result);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(result.processing.model_calls, 0); assert.equal(result.processing.executed_actions, 0);
  assert.ok(result.next_actions.length <= result.budget.max_actions);
  assert.equal(new Set(result.next_actions.map((action) => action.key)).size, result.next_actions.length);
  const gaps = new Set(result.gaps.map((gap) => gap.id));
  for (const action of result.next_actions) {
    assert.match(action.key, /^[a-f\d]{64}$/); assert.ok(action.gap_ids.length);
    assert.ok(action.gap_ids.every((id) => gaps.has(id)));
    assert.ok(action.reason.trim()); assert.ok(Array.isArray(action.preconditions));
  }
}
function blockedDiscovery(): DiscoveryResult {
  return { schema_version: "1.0", status: "unavailable", platform: "bilibili", question: QUESTION,
    queries: [{ id: "query:1", query: "Agent tools", status: "failed", requests_started: 1, pages_received: 0, rows_received: 0, rows_discarded: 0, has_more: null,
      error: { code: "SEARCH_BLOCKED", message: "HTTP 412", retryable: false } }], candidates: [], search_exhaustive: false, stop_reason: "blocked",
    limits: { max_queries: 3, pages_per_query: 1, results_per_query: 20, max_candidates: 10, timeout_seconds: 30, max_response_bytes: 1048576 },
    processing: { duration_ms: 10, queries_attempted: 1, candidates_received: 0, duplicates_merged: 0, candidates_omitted: 0 }, warnings: [], errors: [{ code: "SEARCH_BLOCKED", message: "HTTP 412", retryable: false }] };
}

test("a partial result and single-source wording do not expand an explicitly supplied scope", async () => {
  const material = video({ limitations: ["single_source; not_addressed; more research could be useful"], errors: [{ code: "UPSTREAM_ERROR", message: "Previous synthesis was partial." }] });
  const before = structuredClone(material), next = fixture([material]), fetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => { network++; throw new Error("A plan must not fetch sources or models."); }) as typeof fetch;
  try {
    const result = await planResearchFollowup(REQUEST, next.dependencies);
    assert.equal(next.calls.count, 1); assert.equal(network, 0); assert.deepEqual(result.next_actions, []);
    assert.equal(result.stop_reason, "no_actionable_gaps"); assert.equal(result.materials[0].source_status, "partial");
    assert.deepEqual(material, before); assertContract(result);
  } finally { globalThis.fetch = fetch; }
});

test("source coverage explicitly extends a fifteen-second video with a bounded same-part action", async () => {
  const next = fixture(), result = await planResearchFollowup(request({ coverageTarget: "source", videoWindowSeconds: 60 }), next.dependencies);
  assert.equal(result.status, "planned"); assert.equal(result.stop_reason, "actions_available");
  assert.equal(result.next_actions.length, 1);
  const action = result.next_actions[0];
  assert.equal(action.tool, "analyze_video_url"); assert.equal(action.arguments.url, VIDEO); assert.equal(action.arguments.question, QUESTION);
  assert.equal(action.arguments.mode, "language"); assert.equal(action.arguments.start_seconds, 15); assert.equal(action.arguments.end_seconds, 75);
  assert.ok(result.gaps.some((gap) => gap.kind === "scope_extension" && gap.window?.start_seconds === 15 && gap.window.end_seconds === 169));
  assert.equal(result.materials[0].source_status, "partial"); assertContract(result);
});

test("a window budget limits the first gap chunk without claiming the remaining interval is filled", async () => {
  const next = fixture([video({ requested_window: { start_seconds: 0, end_seconds: 1200 }, duration_seconds: 1200, language_windows: [{ start_seconds: 0, end_seconds: 600 }] })]);
  const result = await planResearchFollowup(request({ videoWindowSeconds: 180 }), next.dependencies);
  assert.equal(result.next_actions.length, 1);
  assert.deepEqual(result.next_actions.map((a) => [a.arguments.start_seconds, a.arguments.end_seconds]), [[600, 780]]);
  assert.ok(result.gaps.some((gap) => gap.window?.start_seconds === 600 && gap.window.end_seconds === 1200)); assertContract(result);
});

test("missing note pages retain original one-based ranges and use the note text mode", async () => {
  const result = await planResearchFollowup(REQUEST, fixture([note()]).dependencies);
  assert.equal(result.status, "planned");
  assert.ok(result.next_actions.length >= 1);
  for (const action of result.next_actions) {
    assert.equal(action.tool, "analyze_xiaohongshu_note"); assert.equal(action.arguments.url, NOTE); assert.equal(action.arguments.mode, "text");
    const start = action.arguments.start_page as number, end = action.arguments.end_page as number;
    assert.ok(start >= 1 && end <= 8 && end >= start && end - start < 4);
    for (let page = start; page <= end; page++) assert.ok([3, 4, 6].includes(page), "the plan does not re-read already covered pages");
  }
  assert.deepEqual([result.next_actions[0].arguments.start_page, result.next_actions[0].arguments.end_page], [3, 4]); assertContract(result);
});

test("a note-page action cap chooses only the first bounded chunk of a larger gap", async () => {
  const result = await planResearchFollowup(request({ notePagesPerAction: 3 }), fixture([note({ language_pages: [] })]).dependencies);
  assert.equal(result.next_actions.length, 1);
  assert.deepEqual([result.next_actions[0].arguments.start_page, result.next_actions[0].arguments.end_page], [1, 3]);
  assert.ok(result.gaps.some((gap) => gap.pages?.start_page === 1 && gap.pages.end_page === 8)); assertContract(result);
});

test("a changed visual question requests real visual inspection without inventing a focus timestamp", async () => {
  const original = video({ original_mode: "vision", requested_window: { start_seconds: 120, end_seconds: 360 }, duration_seconds: 600,
    language_windows: [], visual_windows: [], visual_question_changed: true, eligible: true, source_status: "unavailable" });
  const result = await planResearchFollowup(request({ videoWindowSeconds: 60 }), fixture([original]).dependencies);
  assert.equal(result.next_actions.length, 1); const action = result.next_actions[0];
  assert.equal(action.arguments.mode, "vision"); assert.equal(action.arguments.start_seconds, 120); assert.equal(action.arguments.end_seconds, 180);
  assert.ok(result.gaps.some((gap) => gap.kind === "visual_question_changed"));
  assert.equal(result.materials[0].source_status, "unavailable"); assertContract(result);
});

test("explicit multimodal needs can be satisfied by one typed acquisition action", async () => {
  const value = video({ requested_window: { start_seconds: 0, end_seconds: 120 }, duration_seconds: 120, language_windows: [], visual_windows: [] });
  const result = await planResearchFollowup(request({ evidenceRequirement: "multimodal" }), fixture([value]).dependencies);
  assert.equal(result.next_actions.length, 1); assert.equal(result.next_actions[0].arguments.mode, "multimodal"); assertContract(result);
});

test("complementary material coverage is unioned before deciding that a source has a gap", async () => {
  const a = video({ requested_window: { start_seconds: 0, end_seconds: 1200 }, duration_seconds: 1200, language_windows: [{ start_seconds: 0, end_seconds: 600 }] });
  const b = video({ id: "material:2", requested_window: { start_seconds: 600, end_seconds: 1200 }, duration_seconds: 1200, language_windows: [{ start_seconds: 600, end_seconds: 1200 }], evidence_ids: ["material:2:text:asr2"] });
  const result = await planResearchFollowup(request({ materials: [INPUT, INPUT] }), fixture([a, b]).dependencies);
  assert.deepEqual(result.next_actions, []); assert.equal(result.stop_reason, "no_actionable_gaps"); assertContract(result);
});

test("disjoint requested intervals do not imply permission to fill the unrequested middle", async () => {
  const a = video({ requested_window: { start_seconds: 0, end_seconds: 100 }, duration_seconds: 300, language_windows: [{ start_seconds: 0, end_seconds: 100 }] });
  const b = video({ id: "material:2", requested_window: { start_seconds: 200, end_seconds: 300 }, duration_seconds: 300, language_windows: [{ start_seconds: 200, end_seconds: 300 }], evidence_ids: ["material:2:text:asr2"] });
  const result = await planResearchFollowup(request({ materials: [INPUT, INPUT] }), fixture([a, b]).dependencies);
  assert.deepEqual(result.next_actions, []); assertContract(result);
});

test("duplicate gaps generate one action linked to both input materials", async () => {
  const a = video(), b = video({ id: "material:2", evidence_ids: ["material:2:text:asr1"] });
  const result = await planResearchFollowup(request({ coverageTarget: "source", materials: [INPUT, INPUT] }), fixture([a, b]).dependencies);
  assert.equal(result.next_actions.length, 1);
  assert.deepEqual(new Set(result.next_actions[0].material_ids), new Set([a.id, b.id])); assertContract(result);
});

test("compatible saved sessions use the existing resume tool without exposing mutable research semantics", async () => {
  const value = video({ requested_window: { start_seconds: 0, end_seconds: 1200 }, duration_seconds: 1200,
    language_windows: [{ start_seconds: 0, end_seconds: 600 }], session_id: SESSION, can_resume: true });
  const result = await planResearchFollowup(REQUEST, fixture([value]).dependencies);
  assert.equal(result.next_actions.length, 1); const action = result.next_actions[0];
  assert.equal(action.tool, "resume_long_video_research"); assert.equal(action.arguments.session_id, SESSION);
  assert.equal(action.arguments.question, undefined); assert.equal(action.arguments.mode, undefined); assertContract(result);
});

test("a merged multimodal gap cannot be assigned to a language-only session resume", async () => {
  const saved = video({ requested_window: { start_seconds: 0, end_seconds: 240 }, duration_seconds: 240,
    language_windows: [{ start_seconds: 0, end_seconds: 120 }], session_id: SESSION, can_resume: true, resume_window_seconds: 120 });
  const visual = video({ id: "material:2", original_mode: "vision", requested_window: { start_seconds: 120, end_seconds: 240 }, duration_seconds: 240,
    language_windows: [], visual_windows: [], evidence_ids: [] });
  const result = await planResearchFollowup(request({ materials: [INPUT, INPUT] }), fixture([saved, visual]).dependencies);
  assert.equal(result.status, "planned"); assert.equal(result.next_actions.length, 1);
  assert.equal(result.gaps[0].channel, "multimodal");
  assert.equal(result.next_actions[0].tool, "analyze_video_url"); assert.equal(result.next_actions[0].arguments.mode, "multimodal");
  assert.deepEqual([result.next_actions[0].arguments.start_seconds, result.next_actions[0].arguments.end_seconds], [120, 240]); assertContract(result);
});

test("source access restrictions retain the gap but never dispatch a retry", async (t) => {
  for (const access of ["blocked", "auth_required", "rate_limited"] as const) await t.test(access, async () => {
    const result = await planResearchFollowup(request({ coverageTarget: "source" }), fixture([video({ access })]).dependencies);
    assert.deepEqual(result.next_actions, []); assert.equal(result.stop_reason, "blocked");
    assert.ok(result.gaps.some((gap) => gap.state === "blocked")); assert.equal(result.materials[0].access, access); assertContract(result);
  });
});

test("a blocked search does not block a known source's independent media action", async () => {
  const result = await planResearchFollowup(request({ coverageTarget: "source", searchQueries: ["Agent tools"], discovery: blockedDiscovery() }), fixture().dependencies);
  assert.ok(result.next_actions.some((action) => action.tool === "analyze_video_url"));
  assert.ok(!result.next_actions.some((action) => action.tool === "discover_bilibili_videos"));
  assert.ok(result.gaps.some((gap) => gap.kind === "requested_search" && gap.state === "blocked")); assertContract(result);
});

test("discovery is proposed only for explicitly requested host queries", async () => {
  const result = await planResearchFollowup(request({ searchQueries: ["Agent tools", "自动化 工具"] }), fixture().dependencies);
  assert.equal(result.next_actions.length, 1); const action = result.next_actions[0];
  assert.equal(action.tool, "discover_bilibili_videos"); assert.deepEqual(action.arguments.queries, ["Agent tools", "自动化 工具"]);
  assert.ok((action.arguments.timeout_seconds as number) <= 120); assertContract(result);
});

test("planned search queries share discovery normalization and remain executable", async () => {
  const result = await planResearchFollowup(request({ searchQueries: ["Ａｇｅｎｔ\ttools"] }), fixture().dependencies);
  assert.equal(result.status, "planned"); assert.deepEqual(result.next_actions[0].arguments.queries, ["Agent tools"]);
  assert.ok(discoveryRequestSchema.safeParse({ question: QUESTION, queries: result.next_actions[0].arguments.queries }).success); assertContract(result);
});

test("attempted action history is stable across runtime budgets and is not dispatched again", async () => {
  const first = await planResearchFollowup(request({ coverageTarget: "source" }), fixture().dependencies);
  assert.equal(first.next_actions.length, 1);
  const second = await planResearchFollowup(request({ coverageTarget: "source", actionTimeoutSeconds: 600, attemptedActionKeys: [first.next_actions[0].key] }), fixture().dependencies);
  assert.deepEqual(second.next_actions, []); assert.equal(second.stop_reason, "history_exhausted");
  assert.ok(second.gaps.some((gap) => gap.state === "previously_attempted")); assertContract(second);
});

test("history distinguishes changed acquisition windows or channels from identical actions", async () => {
  const material = video({ requested_window: { start_seconds: 0, end_seconds: 120 }, duration_seconds: 120, language_windows: [] });
  const first = await planResearchFollowup(request({ videoWindowSeconds: 60 }), fixture([material]).dependencies);
  const history = [first.next_actions[0].key];
  const longer = await planResearchFollowup(request({ videoWindowSeconds: 90, attemptedActionKeys: history }), fixture([material]).dependencies);
  assert.equal(longer.status, "planned"); assert.notEqual(longer.next_actions[0].key, history[0]);
  assert.deepEqual([longer.next_actions[0].arguments.start_seconds, longer.next_actions[0].arguments.end_seconds], [0, 90]);
  const visual = await planResearchFollowup(request({ evidenceRequirement: "vision", videoWindowSeconds: 60, attemptedActionKeys: history }), fixture([material]).dependencies);
  assert.equal(visual.status, "planned"); assert.notEqual(visual.next_actions[0].key, history[0]);
  assert.equal(visual.next_actions[0].arguments.mode, "vision"); assertContract(longer); assertContract(visual);
});

test("action and source budgets defer gaps with their original identity and scope", async () => {
  const materials = [video({ requested_window: { start_seconds: 0, end_seconds: 169 }, language_windows: [] }), note()];
  const result = await planResearchFollowup(request({ materials: [INPUT, INPUT], maxActions: 1, maxSources: 1 }), fixture(materials).dependencies);
  assert.equal(result.next_actions.length, 1); assert.ok(result.budget.deferred_gaps > 0);
  assert.ok(result.gaps.some((gap) => gap.state === "deferred")); assertContract(result);
});

test("an exhausted round budget stops before material loading", async () => {
  const next = fixture(); const result = await planResearchFollowup(request({ maxRounds: 2, round: 3 }), next.dependencies);
  assert.equal(result.status, "stopped"); assert.equal(result.stop_reason, "budget_exhausted"); assert.equal(next.calls.count, 0);
  assert.deepEqual(result.next_actions, []); assertContract(result);
});

test("invalid inputs and resource limits reject before preparation", async (t) => {
  const invalid: Array<[string, unknown]> = [
    ["question", request({ question: " " })], ["zero materials", request({ materials: [] })], ["four materials", request({ materials: [INPUT, INPUT, INPUT, INPUT] })],
    ["action zero", request({ maxActions: 0 })], ["action over cap", request({ maxActions: 6 })], ["source zero", request({ maxSources: 0 })], ["round cap", request({ maxRounds: 6 })],
    ["zero round", request({ round: 0 })], ["bad action key", request({ attemptedActionKeys: ["not-an-action-hash"] })], ["too many action keys", request({ attemptedActionKeys: Array(51).fill("a".repeat(64)) })],
    ["window below cap", request({ videoWindowSeconds: 29 })], ["window above cap", request({ videoWindowSeconds: 901 })], ["note page zero", request({ notePagesPerAction: 0 })],
    ["action timeout", request({ actionTimeoutSeconds: 601 })], ["fractional action timeout", request({ actionTimeoutSeconds: 15.5 })], ["planning timeout", request({ planningTimeoutSeconds: 31 })],
    ["invalid search control character", request({ searchQueries: ["Agent\u0000tools"] })],
    ["oversize input", request({ materials: [{ ...INPUT, label: "x".repeat(2 * 1024 * 1024) }] })],
  ];
  for (const [name, value] of invalid) await t.test(name, async () => {
    const next = fixture(), result = await planResearchFollowup(value as FollowupPlanRequest, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.equal(next.calls.count, 0); assert.equal(result.stop_reason, "invalid_request");
    assert.ok(result.errors.length); assert.deepEqual(result.next_actions, []); assertContract(result);
  });
});

test("pre-cancellation performs no preparation or other operation", async () => {
  const next = fixture(), controller = new AbortController(); controller.abort(new DOMException("Fixture cancelled", "AbortError"));
  const result = await planResearchFollowup(REQUEST, next.dependencies, controller.signal);
  assert.equal(next.calls.count, 0); assert.equal(result.stop_reason, "cancelled"); assert.deepEqual(result.next_actions, []); assertContract(result);
});

test("cancellation bounds a noncooperative material loader", { timeout: 5000 }, async () => {
  const controller = new AbortController(), next = fixture();
  next.dependencies.prepare = async () => { next.calls.count++; controller.abort(new DOMException("Fixture cancelled", "AbortError")); return new Promise<PlanningMaterial[]>(() => {}); };
  const result = await planResearchFollowup(REQUEST, next.dependencies, controller.signal);
  assert.equal(next.calls.count, 1); assert.equal(result.stop_reason, "cancelled"); assert.deepEqual(result.next_actions, []); assertContract(result);
});

test("shared planning deadline bounds a stalled loader without executing proposed work", { timeout: 5000 }, async () => {
  const next = fixture(); next.dependencies.prepare = async () => new Promise<PlanningMaterial[]>(() => {});
  const result = await planResearchFollowup(request({ planningTimeoutSeconds: 1 }), next.dependencies);
  assert.equal(result.stop_reason, "timeout"); assert.deepEqual(result.next_actions, []); assertContract(result);
});
