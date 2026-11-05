import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchResult } from "../src/contracts.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";
import type { NoteResearchResult, XiaohongshuResearchResult } from "../src/note-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { researchXiaohongshuNote } from "../src/note-research.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { createResearchTask, runResearchTask } from "../src/research-tasks.js";
import { ResearchTaskStore } from "../src/research-task-store.js";

const NOTE = "6ae80a83000000001a0153d3", OTHER = "6aaaa3300000000025035966";
const EXPLORE = `https://www.xiaohongshu.com/explore/${NOTE}`;
const DISCOVERY = `https://www.xiaohongshu.com/discovery/item/${NOTE}`;
const QUESTION = "Explain the attention diagram";

function input(): FollowupPlanRequest {
  const note: NoteResearchResult = {
    schema_version: "1.0", status: "partial",
    note: { platform: "xiaohongshu", id: NOTE, sourceUrl: DISCOVERY, canonicalUrl: DISCOVERY, title: "Diagram", description: "Body", contentType: "image_note", imageCount: 2 },
    request: { url: DISCOVERY, question: QUESTION, mode: "text", startPage: 1, endPage: 2 },
    capabilities: { body: { status: "not_requested" }, images: { status: "available" }, ocr: { status: "available" }, comments: { status: "unsupported" } },
    evidence: [{ id: "image:1:text", kind: "image_text", source: { platform: "xiaohongshu", note_id: NOTE, url: DISCOVERY, origin: "fixture" }, page: 1, content: "Original page one", limitations: [] }],
    findings: [], analysis: null, warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
  const id = "jNQXAC9IVRw", url = `https://www.youtube.com/watch?v=${id}`;
  const video: ResearchResult = {
    schema_version: "1.0", status: "complete",
    video: { platform: "youtube", id, sourceUrl: url, canonicalUrl: url, title: "Attention", durationSeconds: 15 },
    request: { url, question: QUESTION, mode: "language", startSeconds: 0, endSeconds: 15 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform: "youtube", video_id: id, url, origin: "fixture" }, time_range: { start_seconds: 0, end_seconds: 15 }, time_basis: "source", precision: "requested_window", content: "Original source text", limitations: [] }],
    findings: [], analysis: "Done", warnings: [], errors: [], processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
  return { question: QUESTION, materials: [{ kind: "note", result: note }, { kind: "video", result: video }], maxActions: 1 };
}

async function fixture(work: (store: ResearchTaskStore, host: ResearchTaskHost, calls: { research: number }) => Promise<void>, mutate?: (response: XiaohongshuResearchResult) => void) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-note-alias-")), request = input(), calls = { research: 0 };
  const host: ResearchTaskHost = { callTool: async (name, args) => {
    if (name === "plan_research_followup") return planResearchFollowup(request);
    assert.equal(name, "analyze_xiaohongshu_note"); assert.equal(args.url, EXPLORE);
    calls.research++;
    const response = await researchXiaohongshuNote({ url: args.url as string, question: args.question as string, mode: "text", startPage: args.start_page as number, endPage: args.end_page as number }, {
      resolve: async () => ({ id: NOTE, sourceUrl: EXPLORE, canonicalUrl: DISCOVERY, title: "Diagram", description: "Body", contentType: "image_note", pages: [1, 2].map(index => ({ index, url: `https://image.example/${index}.jpg` })) }),
      acquire: async (_source, pages) => ({ directory: "/fixture", bytes: 100, pages: pages.map(index => ({ index, path: `/fixture/${index}.jpg` })), dispose: async () => undefined }),
      ocr: async pages => pages.map(page => ({ page: page.index, text: "Page two actual OCR", method: "apple_vision", warnings: [] })),
      analyzeText: async () => JSON.stringify({ analysis: "Source text found.", findings: [{ statement: "Source text found.", evidence_ids: ["image:2:text"], limitations: [] }] }),
    });
    assert.equal(response.status, "complete"); assert.ok(response.result && "note" in response.result);
    assert.equal(response.result.request.url, DISCOVERY); assert.equal(response.result.request.startPage, 2);
    mutate?.(response);
    // Match the structured JSON value delivered by the existing MCP transport.
    return JSON.parse(JSON.stringify(response));
  } };
  try { await work(new ResearchTaskStore(directory), host, calls); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("a note tool's equivalent canonical path retains the successful selected page without replay", async () => fixture(async (store, host, calls) => {
  const task = await createResearchTask({ plan: input() }, { store, host });
  assert.equal(task.plan.next_actions.length, 1);
  const action = task.plan.next_actions[0];
  assert.deepEqual([action.arguments.mode, action.arguments.start_page, action.arguments.end_page], ["text", 2, 2]);
  const result = await runResearchTask(task.id, [action.key], { store, host });
  assert.equal(result.status, "completed"); assert.equal(result.actions[0].state, "recorded");
  const wrapper = result.actions[0].result as unknown as XiaohongshuResearchResult, leaf = wrapper.result as NoteResearchResult;
  assert.equal(leaf.request.url, DISCOVERY); assert.deepEqual(leaf.evidence.map(item => item.page), [2]);
  assert.deepEqual(await store.load(task.id), result);
  assert.deepEqual(await runResearchTask(task.id, undefined, { store, host }), result); assert.equal(calls.research, 1);
}));

test("note URL aliases cannot hide a foreign note, host or selected page", async t => {
  const mutations: Array<[string, (response: XiaohongshuResearchResult) => void]> = [
    ["different note identity", response => {
      const leaf = response.result as NoteResearchResult, url = `https://www.xiaohongshu.com/discovery/item/${OTHER}`;
      leaf.note!.id = OTHER; leaf.note!.canonicalUrl = leaf.note!.sourceUrl = leaf.request.url = url;
      for (const item of leaf.evidence) { item.source.note_id = OTHER; item.source.url = url; }
    }],
    ["foreign URL host", response => { (response.result as NoteResearchResult).request.url = `https://foreign.example/explore/${NOTE}`; }],
    ["different requested page", response => {
      const leaf = response.result as NoteResearchResult; leaf.request.startPage = leaf.request.endPage = 1;
      for (const item of leaf.evidence) item.page = 1;
    }],
    ["foreign evidence page", response => { (response.result as NoteResearchResult).evidence[0].page = 1; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => fixture(async (store, host, calls) => {
    const task = await createResearchTask({ plan: input() }, { store, host });
    const result = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host });
    assert.equal(result.status, "needs_attention"); assert.equal(result.actions[0].state, "unknown"); assert.equal(result.actions[0].result, null);
    assert.deepEqual(await runResearchTask(task.id, undefined, { store, host }), result); assert.equal(calls.research, 1);
  }, mutate));
});
