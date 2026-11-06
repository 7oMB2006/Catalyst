import test from "node:test";
import { discoveryResultSchema } from "../src/discovery-schema.js";
import { comparisonResultSchema } from "../src/comparison-schema.js";
import { followupPlanResultSchema } from "../src/followup-plan-schema.js";
import type { ResearchResult } from "../src/contracts.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { longVideoResultSchema } from "../src/long-video-schema.js";
import { researchLongVideo } from "../src/long-video.js";
import { ResearchSessionStore, type ResearchSessionRecord } from "../src/research-session-store.js";

async function connect(directory: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CATALYST_SESSION_DIR: directory },
  });
  const client = new Client({ name: "catalyst-protocol-test", version: "1.0" });
  try { await client.connect(transport); return client; }
  catch (error) { await transport.close(); throw error; }
}

function textContent(response: ReturnType<typeof CallToolResultSchema.parse>): string {
  const content = response.content.find((item) => item.type === "text");
  assert.ok(content && content.type === "text");
  return content.text;
}

test("stdio exposes legacy tools and returns structured routing failures", { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-protocol-"));
  let client: Client | undefined;
  try {
    client = await connect(directory);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "analyze_bilibili_video", "analyze_long_video_url", "analyze_video", "analyze_video_url", "analyze_xiaohongshu_note", "compare_research_materials", "continue_research_task", "delete_research_session", "delete_research_task", "discover_bilibili_videos", "follow_up_long_video_research", "follow_up_research_task", "get_research_session", "get_research_task", "inspect_video_window", "list_research_sessions", "list_research_tasks", "plan_research_followup", "resume_long_video_research", "start_research_task",
    ]);
    assert.ok(tools.tools.find((tool) => tool.name === "analyze_video_url")?.outputSchema);
    const comparisonTool = tools.tools.find((tool) => tool.name === "compare_research_materials");
    assert.ok(comparisonTool?.outputSchema); assert.equal(comparisonTool.annotations?.readOnlyHint, true);
    assert.equal(comparisonTool.inputSchema.additionalProperties, false);
    const missingComparison = CallToolResultSchema.parse(await client.callTool({ name: "compare_research_materials", arguments: { question: "What claims do these materials share?", materials: [{ kind: "session", session_id: randomUUID() }, { kind: "session", session_id: randomUUID() }] } }));
    assert.equal(missingComparison.isError, true);
    const comparison = comparisonResultSchema.parse(missingComparison.structuredContent);
    assert.equal(comparison.status, "unavailable"); assert.equal(comparison.materials.length, 2);
    assert.equal(comparison.processing.model_calls, 0); assert.equal(comparison.source_independence, "not_established");
    assert.deepEqual(JSON.parse(textContent(missingComparison)), missingComparison.structuredContent);
    const discoveryTool = tools.tools.find((tool) => tool.name === "discover_bilibili_videos");
    assert.ok(discoveryTool?.outputSchema);
    assert.equal(discoveryTool.annotations?.readOnlyHint, true);
    assert.equal(discoveryTool.inputSchema.additionalProperties, false);
    assert.equal((discoveryTool.inputSchema.properties?.max_candidates as Record<string, unknown>).default, 10);
    assert.equal((discoveryTool.outputSchema.properties as Record<string, unknown>).evidence, undefined);
    const invalidDiscovery = CallToolResultSchema.parse(await client.callTool({ name: "discover_bilibili_videos", arguments: { question: "x".repeat(201) } }));
    assert.equal(invalidDiscovery.isError, true);
    const discovery = discoveryResultSchema.parse(invalidDiscovery.structuredContent);
    assert.equal(discovery.status, "unavailable"); assert.equal(discovery.errors[0].code, "INVALID_REQUEST");
    assert.equal(discovery.processing.queries_attempted, 0);
    assert.deepEqual(JSON.parse(textContent(invalidDiscovery)), invalidDiscovery.structuredContent);
    const extraDiscovery = CallToolResultSchema.parse(await client.callTool({ name: "discover_bilibili_videos", arguments: { question: "Find attention lectures", pages: 100 } }));
    assert.equal(extraDiscovery.isError, true);
    assert.match(textContent(extraDiscovery), /unrecognized|validation|unknown/i);
    const longTool = tools.tools.find((tool) => tool.name === "analyze_long_video_url");
    assert.ok(longTool?.outputSchema);
    assert.equal((longTool.inputSchema.properties?.segment_seconds as Record<string, unknown>).default, 600);
    assert.equal((longTool.inputSchema.properties?.save_session as Record<string, unknown>).default, true);
    assert.equal(longTool.annotations?.readOnlyHint, false);
    assert.equal(longTool.annotations?.destructiveHint, false);
    const resumeTool = tools.tools.find((tool) => tool.name === "resume_long_video_research");
    assert.ok(resumeTool?.outputSchema);
    assert.equal(resumeTool.annotations?.readOnlyHint, false);
    assert.equal(resumeTool.annotations?.destructiveHint, false);
    assert.equal(resumeTool.inputSchema.properties?.question, undefined);
    assert.equal(resumeTool.inputSchema.properties?.mode, undefined);
    const followUpTool = tools.tools.find((tool) => tool.name === "follow_up_long_video_research");
    assert.ok(followUpTool?.outputSchema);
    assert.equal(followUpTool.annotations?.readOnlyHint, false);
    assert.equal(followUpTool.annotations?.destructiveHint, false);
    assert.equal((followUpTool.inputSchema.properties?.mode as Record<string, unknown>).default, "language");
    assert.deepEqual((followUpTool.inputSchema.properties?.mode as Record<string, unknown>).enum, ["language", "multimodal"]);
    assert.equal(followUpTool.inputSchema.additionalProperties, false);
    assert.ok((followUpTool.outputSchema.properties as Record<string, unknown>).follow_up);
    assert.equal(tools.tools.find((tool) => tool.name === "get_research_session")?.annotations?.readOnlyHint, true);
    assert.ok(tools.tools.find((tool) => tool.name === "get_research_session")?.outputSchema);
    assert.equal(tools.tools.find((tool) => tool.name === "list_research_sessions")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "delete_research_session")?.annotations?.destructiveHint, true);
    const longResponse = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_long_video_url", arguments: { url: "https://example.com/video?token=fixture-private-token", question: "Which concepts are explained?", mode: "multimodal" },
    }));
    assert.equal(longResponse.isError, true);
    const longResult = longVideoResultSchema.parse(longResponse.structuredContent);
    assert.equal(longResult.status, "unavailable");
    assert.equal(longResult.errors[0].code, "UNSUPPORTED_PLATFORM");
    assert.deepEqual(longResult.segments, []);
    assert.doesNotMatch(JSON.stringify(longResponse), /fixture-private-token/);
    const transient = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_long_video_url", arguments: { url: "https://example.com/video?token=fixture-private-token", question: "Which concepts are explained?", mode: "multimodal", save_session: false },
    }));
    assert.equal(transient.isError, true);
    assert.equal(longVideoResultSchema.parse(transient.structuredContent).errors[0].code, "UNSUPPORTED_PLATFORM");
    assert.doesNotMatch(JSON.stringify(transient), /fixture-private-token/);
    const list = CallToolResultSchema.parse(await client.callTool({ name: "list_research_sessions", arguments: {} }));
    assert.deepEqual(list.structuredContent, { sessions: [] });
    assert.deepEqual(await fs.readdir(directory), []);
    const unknown = randomUUID();
    for (const name of ["get_research_session", "resume_long_video_research", "delete_research_session"]) {
      const missing = CallToolResultSchema.parse(await client.callTool({ name, arguments: { session_id: unknown } }));
      assert.equal(missing.isError, true);
      assert.equal(JSON.parse(textContent(missing)).error.code, "SESSION_NOT_FOUND");
      const invalid = CallToolResultSchema.parse(await client.callTool({ name, arguments: { session_id: "../outside-session" } }));
      assert.equal(invalid.isError, true);
      assert.match(textContent(invalid), /validation|uuid|session_id/i);
    }
    const changedQuestion = CallToolResultSchema.parse(await client.callTool({ name: "resume_long_video_research", arguments: { session_id: unknown, question: "A different research question" } }));
    assert.equal(changedQuestion.isError, true);
    assert.match(textContent(changedQuestion), /unrecognized|question|unknown key/i);
    const missingFollowUp = CallToolResultSchema.parse(await client.callTool({ name: "follow_up_long_video_research", arguments: { session_id: unknown, question: "How do the mechanisms differ?" } }));
    assert.equal(missingFollowUp.isError, true);
    assert.equal(JSON.parse(textContent(missingFollowUp)).error.code, "SESSION_NOT_FOUND");
    for (const arguments_ of [
      { session_id: unknown, question: "How do the mechanisms differ?", mode: "vision" },
      { session_id: unknown, question: "How do the mechanisms differ?", language: "en" },
      { session_id: unknown, question: "How do the mechanisms differ?", start_seconds: 60 },
    ]) {
      const invalid = CallToolResultSchema.parse(await client.callTool({ name: "follow_up_long_video_research", arguments: arguments_ }));
      assert.equal(invalid.isError, true);
      assert.match(textContent(invalid), /validation|unrecognized|invalid/i);
    }
    const noteTool = tools.tools.find((tool) => tool.name === "analyze_xiaohongshu_note");
    assert.ok(noteTool?.outputSchema);
    assert.equal((noteTool.inputSchema.properties?.mode as Record<string, unknown>).default, "text");
    const response = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_video_url",
      arguments: { url: "https://example.com/video", question: "What is shown?", mode: "vision" },
    }));
    assert.equal(response.isError, true);
    const result = response.structuredContent;
    assert.ok(result && typeof result === "object" && !Array.isArray(result));
    assert.equal(result.schema_version, "1.0");
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.evidence, []);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    assert.equal((result.errors[0] as Record<string, unknown>).code, "UNSUPPORTED_PLATFORM");
    const text = response.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text), result);
    const ambiguousShare = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_video_url",
      arguments: { url: "视频 https://xhslink.cn/o/one?xsec_token=fixture-private-token 另一个 https://xhslink.com/a/two", question: "What is shown?", mode: "vision" },
    }));
    assert.equal(ambiguousShare.isError, true);
    assert.equal((ambiguousShare.structuredContent?.errors as Array<Record<string, unknown>>)[0].code, "INVALID_URL");
    assert.doesNotMatch(JSON.stringify(ambiguousShare), /fixture-private-token/);
    const noteResponse = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_xiaohongshu_note",
      arguments: {
        url: "https://xhslink.cn/o/one?xsec_token=fixture-private-token，另一个：https://xhslink.cn/o/two",
        question: "What does the author recommend?",
      },
    }));
    assert.equal(noteResponse.isError, true);
    assert.equal(noteResponse.structuredContent?.content_type, "unknown");
    assert.equal(noteResponse.structuredContent?.status, "unavailable");
    assert.equal(noteResponse.structuredContent?.result, null);
    assert.equal((noteResponse.structuredContent?.errors as Array<Record<string, unknown>>)[0].code, "INVALID_URL");
    assert.doesNotMatch(JSON.stringify(noteResponse), /fixture-private-token/);
  } finally {
    await client?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stdio plans bounded follow-up actions without executing them and retains material failures", { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-protocol-plan-"));
  let client: Client | undefined;
  try {
    client = await connect(directory);
    const tools = await client.listTools(), tool = tools.tools.find((item) => item.name === "plan_research_followup");
    assert.ok(tool?.outputSchema);
    assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.openWorldHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const [name, value] of Object.entries({
      evidence_requirement: "original", coverage_target: "requested", max_actions: 3, max_sources: 2, max_rounds: 2,
      round: 1, attempted_action_keys: [], video_window_seconds: 180, note_pages_per_action: 4,
      action_timeout_seconds: 240, planning_timeout_seconds: 10,
    })) assert.deepEqual((tool.inputSchema.properties?.[name] as Record<string, unknown>).default, value);

    const question = "Which attention mechanism is explained?", url = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
    const material: ResearchResult = {
      schema_version: "1.0", status: "partial",
      video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: `${url}&token=fixture-private-token`, canonicalUrl: url, title: "Attention lesson", durationSeconds: 120 },
      request: { url, question, mode: "language", startSeconds: 0, endSeconds: 15 },
      capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
      evidence: [{ id: "asr:1", kind: "asr", source: { platform: "bilibili", video_id: "BV1DTxXzUEvW", part_id: "38253823575", url, origin: "fixture" }, time_range: { start_seconds: 0, end_seconds: 15 }, time_basis: "source", precision: "requested_window", content: "The lesson explains sparse attention.", limitations: [] }],
      findings: [], analysis: "OLD_FINAL_ANSWER", warnings: [], errors: [],
      processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
    };
    const arguments_ = { question, materials: [{ kind: "video", result: material }] };
    const callPlan = async (arguments__: Record<string, unknown>) => {
      const response = CallToolResultSchema.parse(await client!.callTool({ name: "plan_research_followup", arguments: arguments__ }));
      const plan = followupPlanResultSchema.parse(response.structuredContent);
      assert.deepEqual(JSON.parse(textContent(response)), response.structuredContent);
      assert.equal(plan.processing.model_calls, 0); assert.equal(plan.processing.executed_actions, 0);
      assert.doesNotMatch(JSON.stringify(response), /fixture-private-token|OLD_FINAL_ANSWER/);
      return { response, plan };
    };
    const original = await callPlan(arguments_);
    assert.notEqual(original.response.isError, true); assert.equal(original.plan.status, "stopped");
    assert.equal(original.plan.stop_reason, "no_actionable_gaps"); assert.deepEqual(original.plan.next_actions, []);
    assert.equal(original.plan.materials[0].source_status, "partial");
    assert.deepEqual(original.plan.budget, { max_actions: 3, max_sources: 2, max_rounds: 2, round: 1, deferred_gaps: 0 });

    const extendedArguments = {
      ...arguments_, evidence_requirement: "language", coverage_target: "source", max_actions: 1, max_sources: 1,
      max_rounds: 3, round: 2, video_window_seconds: 30, note_pages_per_action: 6,
      action_timeout_seconds: 45, planning_timeout_seconds: 4,
    };
    const extended = await callPlan(extendedArguments);
    assert.notEqual(extended.response.isError, true); assert.equal(extended.plan.status, "planned");
    assert.equal(extended.plan.stop_reason, "actions_available"); assert.equal(extended.plan.next_actions.length, 1);
    assert.deepEqual(extended.plan.budget, { max_actions: 1, max_sources: 1, max_rounds: 3, round: 2, deferred_gaps: 0 });
    const action = extended.plan.next_actions[0];
    assert.equal(action.tool, "analyze_video_url");
    assert.deepEqual(action.arguments, { url, question, mode: "language", include_comments: false, start_seconds: 15, end_seconds: 45, timeout_seconds: 45 });
    assert.match(action.key, /^[a-f\d]{64}$/);
    assert.ok(action.gap_ids.every((id) => extended.plan.gaps.some((gap) => gap.id === id && gap.kind === "scope_extension")));
    const attempted = await callPlan({ ...extendedArguments, round: 3, action_timeout_seconds: 60, attempted_action_keys: [action.key] });
    assert.equal(attempted.plan.stop_reason, "history_exhausted"); assert.deepEqual(attempted.plan.next_actions, []);
    assert.ok(attempted.plan.gaps.some((gap) => gap.state === "previously_attempted"));
    const exhausted = await callPlan({ ...extendedArguments, round: 4 });
    assert.equal(exhausted.plan.stop_reason, "budget_exhausted"); assert.deepEqual(exhausted.plan.materials, []);

    for (const input of [{ kind: "video", result: {} }, { kind: "session", session_id: randomUUID() }]) {
      const failed = await callPlan({ question, materials: [input] });
      assert.notEqual(failed.response.isError, true); assert.equal(failed.plan.status, "stopped");
      assert.equal(failed.plan.stop_reason, "blocked"); assert.deepEqual(failed.plan.next_actions, []);
      assert.equal(failed.plan.materials[0].eligible, false); assert.ok(failed.plan.materials[0].errors.length);
      assert.ok(failed.plan.gaps.some((gap) => gap.kind === "invalid_material" && gap.state === "needs_selection"));
      if (input.kind === "session") assert.ok(failed.plan.materials[0].errors.some((error) => error.code === "SESSION_NOT_FOUND"));
    }
    for (const invalidArguments of [
      { ...arguments_, maxActions: 1 }, { ...arguments_, max_actions: 0 },
      { ...arguments_, materials: [] }, { ...arguments_, evidence_requirement: "text" },
    ]) {
      const response = CallToolResultSchema.parse(await client.callTool({ name: "plan_research_followup", arguments: invalidArguments }));
      assert.equal(response.isError, true); assert.match(textContent(response), /validation|unrecognized|invalid|too small/i);
    }
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await client?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a new stdio process reads, lists and deletes an independent follow-up with lineage and source citations without provider calls", { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-protocol-session-"));
  let client: Client | undefined;
  try {
    const url = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
    const request = { url, question: "Which mechanisms are explained?", mode: "language" as const, segmentSeconds: 120, maxDetailWindows: 0 };
    let analysisCalls = 0;
    const research = await researchLongVideo(request, {
      resolve: async () => ({
        video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: url, canonicalUrl: url, title: "Selected part17", durationSeconds: 120 },
        captions: { status: "available", kind: "manual", language: "en", cues: [{ start: 0, end: 120, content: "The source explains sparse self-attention." }] },
        comments: { status: "disabled", items: [] },
        capabilities: { metadata: { status: "available" }, captions: { status: "available" }, media: { status: "not_requested" }, comments: { status: "disabled" } }, warnings: [],
      }),
      acquireWindow: async () => { throw new Error("Caption fixture must not acquire media."); },
      transcribe: async () => { throw new Error("Caption fixture must not use ASR."); },
      analyzeText: async () => {
        analysisCalls++;
        return JSON.stringify({ analysis: "The source discusses sparse self-attention.", findings: [{ statement: "Sparse self-attention is explained.", evidence_ids: ["overview:1:source"], limitations: ["Fixture interpretation"] }], relevance_score: 1 });
      },
    });
    assert.equal(research.status, "complete"); assert.equal(analysisCalls, 2);
    const store = new ResearchSessionStore(directory), id = store.newId(), now = new Date().toISOString();
    research.follow_up = { parent_session_id: store.newId(), parent_revision: 4, reused_evidence_ids: ["overview:1:source"] };
    research.session = { id, revision: 1, created_at: now, updated_at: now, reused_segments: 0, processed_segments: 1 };
    const saved: ResearchSessionRecord = { schema_version: "1", id, revision: 1, created_at: now, updated_at: now, compatibility: "protocol-fixture", request: research.request, result: research };
    await store.withLock(id, () => store.save(saved, null));
    client = await connect(directory);
    const listed = CallToolResultSchema.parse(await client.callTool({ name: "list_research_sessions", arguments: {} }));
    const sessions = listed.structuredContent?.sessions as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 1); assert.equal(sessions[0].id, id); assert.equal(sessions[0].completed_segments, 1);
    assert.equal(sessions[0].question, request.question); assert.equal(sessions[0].parent_session_id, research.follow_up.parent_session_id); assert.equal(sessions[0].parent_revision, 4);
    const response = CallToolResultSchema.parse(await client.callTool({ name: "get_research_session", arguments: { session_id: id } }));
    assert.notEqual(response.isError, true);
    const restored = longVideoResultSchema.parse(response.structuredContent);
    assert.equal(restored.session?.id, id); assert.equal(restored.session?.revision, 1);
    assert.deepEqual(restored.follow_up, research.follow_up);
    assert.equal(restored.video?.partId, "38253823575");
    assert.deepEqual(restored.coverage, research.coverage);
    assert.deepEqual(restored.evidence, research.evidence);
    assert.deepEqual(restored.findings, research.findings);
    assert.deepEqual(JSON.parse(textContent(response)), response.structuredContent);
    const deleted = CallToolResultSchema.parse(await client.callTool({ name: "delete_research_session", arguments: { session_id: id } }));
    assert.deepEqual(deleted.structuredContent, { session_id: id, deleted: true });
    const empty = CallToolResultSchema.parse(await client.callTool({ name: "list_research_sessions", arguments: {} }));
    assert.deepEqual(empty.structuredContent, { sessions: [] });
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await client?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
