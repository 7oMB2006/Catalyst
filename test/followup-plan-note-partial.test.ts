import assert from "node:assert/strict";
import test from "node:test";
import type { NoteDependencies, NoteResearchResult, XiaohongshuResearchResult } from "../src/note-contracts.js";
import { researchXiaohongshuNote } from "../src/note-research.js";
import { preparePlanningMaterials } from "../src/followup-plan-materials.js";
import { planResearchFollowup } from "../src/followup-plan.js";

const NOTE = "6ae80a83000000001a0153d3", URL = `https://www.xiaohongshu.com/explore/${NOTE}`;
const QUESTION = "How do the diagram arrows connect the tools?";

async function partialNote(mode: "vision" | "combined", failedBatches: number[] = [2]) {
  const calls = { acquired: [] as number[], visionBatches: 0, analysis: 0, disposed: 0 };
  const dependencies: NoteDependencies = {
    resolve: async () => ({
      id: NOTE, sourceUrl: URL, canonicalUrl: URL, title: "Tool diagram", description: "Source body",
      contentType: "image_note", pages: Array.from({ length: 7 }, (_, i) => ({ index: i + 1, url: `https://image.example/${i + 1}.jpg` })),
    }),
    acquire: async (_source, pages) => {
      calls.acquired = [...pages];
      return { directory: "/fixture", bytes: 100, pages: pages.map((index) => ({ index, path: `/fixture/${index}.jpg` })), dispose: async () => { calls.disposed++; } };
    },
    ocr: async (pages) => pages.map(({ index }) => ({ page: index, text: `Original page ${index} text`, method: "apple_vision", warnings: [] })),
    analyzeImages: async (paths) => {
      calls.visionBatches++;
      if (failedBatches.includes(calls.visionBatches)) throw new Error("Fixture visual batch failed");
      return JSON.stringify({ pages: paths.map((_path, index) => ({ image_index: index + 1, observation: `Visible diagram for image ${index + 1}` })) });
    },
    analyzeText: async () => { calls.analysis++; throw new Error("Fixture final synthesis failed"); },
  };
  const wrapper = await researchXiaohongshuNote({ url: URL, question: QUESTION, mode, startPage: 3, endPage: 7 }, dependencies);
  assert.equal(wrapper.content_type, "image_note"); assert.equal(wrapper.status, "partial");
  assert.ok(wrapper.result && "note" in wrapper.result);
  assert.deepEqual(calls.acquired, [3, 4, 5, 6, 7]); assert.equal(calls.analysis, 1); assert.equal(calls.disposed, 1);
  assert.equal(wrapper.result.capabilities.images.status, "available");
  assert.deepEqual(wrapper.result.findings, []); assert.equal(wrapper.result.analysis, null);
  return { wrapper, result: wrapper.result, calls };
}

const prepare = (result: XiaohongshuResearchResult, question = QUESTION) => preparePlanningMaterials([{ kind: "xiaohongshu", result }], question, { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
const plan = (result: XiaohongshuResearchResult, question = QUESTION) => planResearchFollowup({ question, materials: [{ kind: "xiaohongshu", result }] });

test("partial note coverage preserves successful visual pages after a later batch and final synthesis fail", async () => {
  const { wrapper, result } = await partialNote("combined");
  assert.deepEqual(result.evidence.filter((item) => item.kind === "image_visual").map((item) => item.page), [3, 4, 5, 6]);
  assert.deepEqual(result.errors.map((issue) => issue.stage), ["vision", "analysis"]);
  const before = structuredClone(wrapper), [material] = await prepare(wrapper);
  assert.equal(material.eligible, true); assert.equal(material.source_status, "partial");
  assert.deepEqual(material.visual_pages, [3, 4, 5, 6]); assert.deepEqual(material.language_pages, [3, 4, 5, 6, 7]);
  const next = await plan(wrapper);
  assert.equal(next.next_actions.length, 1);
  const action = next.next_actions[0];
  assert.equal(action.tool, "analyze_xiaohongshu_note");
  assert.deepEqual([action.arguments.mode, action.arguments.start_page, action.arguments.end_page], ["vision", 7, 7]);
  assert.deepEqual(next.gaps.map((gap) => gap.pages), [{ start_page: 7, end_page: 7 }]);
  assert.deepEqual(wrapper, before);
});

test("visual-only observations remain covered after synthesis fails without any final findings", async () => {
  const { wrapper, result } = await partialNote("vision", []);
  assert.equal(result.evidence.length, 5); assert.ok(result.evidence.every((item) => item.kind === "image_visual"));
  assert.deepEqual(result.errors.map((issue) => issue.stage), ["analysis"]);
  const [material] = await prepare(wrapper);
  assert.equal(material.eligible, true); assert.equal(material.source_status, "partial");
  assert.deepEqual(material.visual_pages, [3, 4, 5, 6, 7]); assert.deepEqual(material.language_pages, []);
  const next = await plan(wrapper);
  assert.equal(next.stop_reason, "no_actionable_gaps"); assert.deepEqual(next.next_actions, []);
});

test("changed questions exclude partial note visual coverage while retaining original OCR", async () => {
  const { wrapper } = await partialNote("combined");
  const question = "What colors label the diagram arrows?", [material] = await prepare(wrapper, question);
  assert.equal(material.eligible, true); assert.equal(material.visual_question_changed, true);
  assert.deepEqual(material.visual_pages, []); assert.deepEqual(material.language_pages, [3, 4, 5, 6, 7]);
  const next = await plan(wrapper, question);
  assert.equal(next.gaps[0].kind, "visual_question_changed");
  assert.deepEqual([next.next_actions[0].arguments.mode, next.next_actions[0].arguments.start_page, next.next_actions[0].arguments.end_page], ["vision", 3, 6]);
});

test("acquired images and successful OCR never count as successful visual inspection", async () => {
  const { wrapper, result } = await partialNote("combined", [1, 2]);
  assert.deepEqual(result.processing.processed_pages, [3, 4, 5, 6, 7]);
  assert.ok(result.evidence.every((item) => item.kind === "image_text"));
  const [material] = await prepare(wrapper);
  assert.equal(material.eligible, true); assert.deepEqual(material.visual_pages, []);
  const next = await plan(wrapper);
  assert.deepEqual([next.next_actions[0].arguments.mode, next.next_actions[0].arguments.start_page, next.next_actions[0].arguments.end_page], ["vision", 3, 6]);
});

test("partial visual coverage still rejects invalid source identities and page locators", async (t) => {
  const { wrapper } = await partialNote("vision", []);
  const mutations: Array<[string, (result: NoteResearchResult) => void]> = [
    ["foreign note", (result) => { result.evidence[0].source.note_id = "6aaaa3300000000025035966"; }],
    ["foreign source URL", (result) => { result.evidence[0].source.url = "https://www.xiaohongshu.com/explore/6aaaa3300000000025035966"; }],
    ["before selected range", (result) => { result.evidence[0].page = 2; }],
    ["after selected range", (result) => { result.evidence[0].page = 8; }],
    ["invalid fractional page", (result) => { result.evidence[0].page = 3.5; }],
    ["duplicate evidence identity", (result) => { result.evidence[1].id = result.evidence[0].id; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const invalid = structuredClone(wrapper); mutate(invalid.result as NoteResearchResult);
    const [material] = await prepare(invalid);
    assert.equal(material.eligible, false); assert.deepEqual(material.visual_pages, []);
    const next = await plan(invalid);
    assert.deepEqual(next.next_actions, []); assert.equal(next.gaps[0].kind, "invalid_material");
  });
});
