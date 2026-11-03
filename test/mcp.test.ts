import test from "node:test";
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
      "analyze_bilibili_video", "analyze_long_video_url", "analyze_video", "analyze_video_url", "analyze_xiaohongshu_note", "delete_research_session", "get_research_session", "inspect_video_window", "list_research_sessions", "resume_long_video_research",
    ]);
    assert.ok(tools.tools.find((tool) => tool.name === "analyze_video_url")?.outputSchema);
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

test("a new stdio process reads, lists and deletes a durable result with its source citations without provider calls", { timeout: 20_000 }, async () => {
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
    research.session = { id, revision: 1, created_at: now, updated_at: now, reused_segments: 0, processed_segments: 1 };
    const saved: ResearchSessionRecord = { schema_version: "1", id, revision: 1, created_at: now, updated_at: now, compatibility: "protocol-fixture", request: research.request, result: research };
    await store.withLock(id, () => store.save(saved, null));
    client = await connect(directory);
    const listed = CallToolResultSchema.parse(await client.callTool({ name: "list_research_sessions", arguments: {} }));
    const sessions = listed.structuredContent?.sessions as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 1); assert.equal(sessions[0].id, id); assert.equal(sessions[0].completed_segments, 1);
    const response = CallToolResultSchema.parse(await client.callTool({ name: "get_research_session", arguments: { session_id: id } }));
    assert.notEqual(response.isError, true);
    const restored = longVideoResultSchema.parse(response.structuredContent);
    assert.equal(restored.session?.id, id); assert.equal(restored.session?.revision, 1);
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
