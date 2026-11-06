import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchResult } from "../src/contracts.js";
import type { ComparisonInput, ComparisonRequest, ComparisonResult } from "../src/comparison-contracts.js";
import type { NoteResearchResult } from "../src/note-contracts.js";
import { answerResearchMaterials, compareResearchMaterials } from "../src/comparison.js";
import { answerRequestSchema, comparisonRequestSchema, comparisonResultSchema } from "../src/comparison-schema.js";

const QUESTION = "Using these tutorials, list the minimum implementation steps and cite the supplied evidence.";
const VIDEO_URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const NOTE_URL = "https://www.xiaohongshu.com/explore/6ae80a83000000001a0153d3";

function video(): ResearchResult {
  return {
    schema_version: "1.0", status: "complete",
    video: { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: VIDEO_URL, canonicalUrl: VIDEO_URL, title: "Agent tutorial", durationSeconds: 120 },
    request: { url: VIDEO_URL, question: "What does this tutorial discuss?", mode: "language", startSeconds: 30, endSeconds: 60 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform: "bilibili", video_id: "BV1DTxXzUEvW", part_id: "38253823575", url: VIDEO_URL, origin: "fixture_asr" }, time_range: { start_seconds: 30, end_seconds: 60 }, time_basis: "source", precision: "requested_window", content: "First register the available tools. Then let the host choose which tool to call.", limitations: ["ASR is not independently verified."] }],
    findings: [{ id: "old:language", statement: "OLD_GENERATED_FINDING_MUST_NOT_APPEAR", evidence_ids: ["asr:1"], verification: "unverified", limitations: [] }],
    analysis: "OLD_FINAL_ANSWER_MUST_NOT_APPEAR", warnings: [], errors: [],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}
function note(): NoteResearchResult {
  return {
    schema_version: "1.0", status: "complete",
    note: { platform: "xiaohongshu", id: "6ae80a83000000001a0153d3", sourceUrl: NOTE_URL, canonicalUrl: NOTE_URL, title: "Agent setup note", description: "Setup examples", contentType: "image_note", imageCount: 3 },
    request: { url: NOTE_URL, question: "What does this note describe?", mode: "text", startPage: 2, endPage: 2 },
    capabilities: { body: { status: "available" }, images: { status: "available" }, ocr: { status: "available" }, comments: { status: "unsupported" } },
    evidence: [{ id: "image:2:text", kind: "image_text", source: { platform: "xiaohongshu", note_id: "6ae80a83000000001a0153d3", url: NOTE_URL, origin: "fixture_ocr" }, page: 2, content: "Register tools, then configure the host to select a tool for each request.", limitations: ["OCR is not independently verified."] }],
    findings: [], analysis: "OLD_NOTE_ANSWER_MUST_NOT_APPEAR", warnings: [], errors: [],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null, selected_pages: [2], processed_pages: [2] },
  };
}
interface Quote { id: string; material_id: string; quote: string }
function catalog(prompt: string): Quote[] {
  const marker = "QUOTE CATALOG:\n\n", index = prompt.lastIndexOf(marker);
  assert.notEqual(index, -1); return JSON.parse(prompt.slice(index + marker.length));
}
function answerPoint(quotes: Quote[], claim = "Register the tools before asking the host to select one.") {
  return { claim, positions: [...new Set(quotes.map(q => q.material_id))].map(id => ({ material_id: id, stance: "supports", citation_ids: [quotes.find(q => q.material_id === id)!.id], explanation: "The selected source excerpt describes this implementation step." })), limitations: ["Only the supplied reading scope supports this step."] };
}
function assertCitations(result: ComparisonResult): void {
  assert.ok(comparisonResultSchema.safeParse(result).success);
  assert.equal(result.source_independence, "not_established");
  const evidence = new Map(result.evidence.map(e => [e.id, e]));
  for (const row of result.comparisons) {
    assert.equal(row.verification, "unverified");
    for (const position of row.positions) for (const citation of position.citations) {
      const item = evidence.get(citation.evidence_id);
      assert.ok(item); assert.equal(item.material_id, position.material_id); assert.ok(item.content.includes(citation.quote));
    }
  }
}
const request = (materials: ComparisonInput[]): ComparisonRequest => ({ question: QUESTION, materials, language: "en", timeoutSeconds: 5 });

test("one retained video answers a new question with source-time citations and one bounded text call", async () => {
  const material = video(), before = structuredClone(material), controller = new AbortController();
  let calls = 0, seen = "", propagated = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Saved-material answers must not fetch sources or media."); };
  try {
    const result = await answerResearchMaterials(request([{ kind: "video", result: material }]), { analyzeText: async (prompt, context, language) => {
      calls++; seen = prompt; propagated = context.signal instanceof AbortSignal && context.deadlineMs > Date.now();
      assert.equal(language, "en"); return JSON.stringify({ comparisons: [answerPoint(catalog(prompt))] });
    } }, controller.signal);
    assert.equal(result.status, "complete"); assert.equal(calls, 1); assert.equal(result.processing.model_calls, 1); assert.equal(propagated, true);
    assert.match(seen, /Answer the user's current question directly/); assert.match(seen, /order the supported steps/);
    assert.ok(seen.includes(QUESTION)); assert.doesNotMatch(seen, /OLD_FINAL_ANSWER_MUST_NOT_APPEAR|OLD_GENERATED_FINDING_MUST_NOT_APPEAR/);
    assert.equal(result.comparisons[0].relation, "single_source"); assert.match(result.analysis!, /^1\. \[single_source\]/);
    assert.deepEqual(result.evidence[0].locator.time_range, { start_seconds: 30, end_seconds: 60 }); assert.equal(result.evidence[0].locator.part_id, "38253823575");
    assert.equal(result.comparisons[0].positions[0].citations[0].quote, material.evidence[0].content);
    assert.deepEqual(material, before); assertCitations(result);
  } finally { globalThis.fetch = originalFetch; }
});

test("one retained OCR note answers independently while preserving its original image page", async () => {
  const material = note();
  const result = await answerResearchMaterials(request([{ kind: "note", result: material }]), { analyzeText: async prompt => {
    assert.doesNotMatch(prompt, /OLD_NOTE_ANSWER_MUST_NOT_APPEAR/);
    return JSON.stringify({ comparisons: [answerPoint(catalog(prompt))] });
  } });
  assert.equal(result.status, "complete"); assert.equal(result.processing.model_calls, 1);
  assert.equal(result.evidence[0].original_id, "image:2:text"); assert.equal(result.evidence[0].locator.page, 2); assert.equal(result.evidence[0].locator.time_range, null);
  assertCitations(result);
});

test("ordered answer points cite both source types and restore selected exact excerpts", async () => {
  const result = await answerResearchMaterials(request([{ kind: "video", result: video() }, { kind: "note", result: note() }]), { analyzeText: async prompt => {
    const quotes = catalog(prompt);
    return JSON.stringify({ comparisons: [answerPoint(quotes, "First register the available tools."), answerPoint(quotes, "Then let the host choose a registered tool.")] });
  } });
  assert.equal(result.status, "complete"); assert.equal(result.comparisons.length, 2); assert.equal(result.processing.model_calls, 1);
  assert.ok(result.analysis!.indexOf("First register") < result.analysis!.indexOf("Then let"));
  assert.deepEqual(result.evidence.map(e => e.locator.page), [null, 2]); assertCitations(result);
});

test("a foreign source's quote cannot support an answer point for another material", async () => {
  const result = await answerResearchMaterials(request([{ kind: "video", result: video() }, { kind: "note", result: note() }]), { analyzeText: async prompt => {
    const quotes = catalog(prompt), invalid = answerPoint(quotes, "INVALID_FOREIGN_STEP");
    invalid.positions[0].citation_ids = [quotes.find(q => q.material_id === "material:2")!.id];
    return JSON.stringify({ comparisons: [invalid, answerPoint(quotes)] });
  } });
  assert.equal(result.status, "partial"); assert.equal(result.comparisons.length, 1); assert.ok(result.errors.some(e => e.code === "INVALID_CITATION"));
  assert.doesNotMatch(result.analysis!, /INVALID_FOREIGN_STEP/); assertCitations(result);
});

test("unknown quote IDs and rewritten literal quotations cannot establish an answer point", async t => {
  for (const invalidCitation of ["unknown", "rewritten"] as const) await t.test(invalidCitation, async () => {
    const result = await answerResearchMaterials(request([{ kind: "video", result: video() }]), { analyzeText: async prompt => {
      const quotes = catalog(prompt), invalid: Record<string, unknown> = answerPoint(quotes);
      invalid.positions = invalidCitation === "unknown" ? [{ material_id: "material:1", stance: "supports", citation_ids: ["quote:missing"], explanation: "Unsupported." }]
        : [{ material_id: "material:1", stance: "supports", citations: [{ evidence_id: "material:1:text:asr%3A1", quote: "A model-rewritten nonexistent quotation." }], explanation: "Unsupported." }];
      return JSON.stringify({ comparisons: [invalid] });
    } });
    assert.equal(result.status, "unavailable"); assert.equal(result.comparisons.length, 0); assert.equal(result.analysis, null); assertCitations(result);
  });
});

test("partial retained input remains partial when its cited answer succeeds", async () => {
  const material = video(); material.status = "partial"; material.warnings = ["Only the retained 30–60 second interval is available."];
  const result = await answerResearchMaterials(request([{ kind: "video", result: material }]), { analyzeText: async prompt => JSON.stringify({ comparisons: [answerPoint(catalog(prompt))] }) });
  assert.equal(result.status, "partial"); assert.equal(result.materials[0].status, "partial");
  assert.ok(result.materials[0].limitations.some(l => /original research was partial/.test(l))); assert.equal(result.evidence.length, 1); assertCitations(result);
});

test("old question-specific visual observations do not answer a changed question", async () => {
  const material = video(); material.request.mode = "multimodal";
  material.evidence.push({ ...material.evidence[0], id: "visual:1", kind: "visual" });
  material.findings.push({ id: "old:visual", statement: "OLD_VISUAL_ASSERTION_MUST_NOT_APPEAR", evidence_ids: ["visual:1"], verification: "unverified", limitations: [] });
  const result = await answerResearchMaterials(request([{ kind: "video", result: material }]), { analyzeText: async prompt => {
    assert.doesNotMatch(prompt, /OLD_VISUAL_ASSERTION_MUST_NOT_APPEAR/);
    return JSON.stringify({ comparisons: [answerPoint(catalog(prompt))] });
  } });
  assert.equal(result.status, "partial"); assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].basis, "source_text"); assertCitations(result);
});

test("no retained source evidence returns unavailable without a provider call", async () => {
  const material = video(); material.evidence = []; material.findings = [];
  let calls = 0;
  const result = await answerResearchMaterials(request([{ kind: "video", result: material }]), { analyzeText: async () => { calls++; throw new Error("No source evidence should be sent."); } });
  assert.equal(result.status, "unavailable"); assert.equal(result.processing.model_calls, 0); assert.equal(calls, 0);
  assert.equal(result.materials.length, 1); assert.equal(result.materials[0].status, "unavailable"); assertCitations(result);
});

test("answering enforces the same input and preparation budgets without silently truncating evidence", async t => {
  await t.test("whole request bytes", async () => {
    const material = video(); material.video!.metadata = { retained_context: "x".repeat(2 * 1024 * 1024) };
    const result = await answerResearchMaterials(request([{ kind: "video", result: material }]), { analyzeText: async () => { throw new Error("Budget must stop before the model."); } });
    assert.equal(result.status, "unavailable"); assert.equal(result.processing.model_calls, 0); assert.ok(result.errors.some(e => e.code === "MATERIAL_BUDGET_EXCEEDED")); assert.equal(result.materials.length, 0);
  });
  await t.test("per-material evidence", async () => {
    const material = video(); material.evidence = Array.from({ length: 81 }, (_, i) => ({ ...material.evidence[0], id: `asr:${i}` })); material.findings = [];
    const result = await answerResearchMaterials(request([{ kind: "video", result: material }]), { analyzeText: async () => { throw new Error("Budget must stop before the model."); } });
    assert.equal(result.status, "unavailable"); assert.equal(result.processing.model_calls, 0); assert.equal(result.materials[0].status, "unavailable");
    assert.ok(result.materials[0].errors.some(e => e.code === "MATERIAL_BUDGET_EXCEEDED")); assert.equal(result.evidence.length, 0); assert.equal(material.evidence.length, 81);
  });
});

test("the answer entry accepts one material while the existing comparison contract still requires two", async () => {
  const single = request([{ kind: "video", result: video() }]);
  assert.equal(answerRequestSchema.safeParse(single).success, true); assert.equal(comparisonRequestSchema.safeParse(single).success, false);
  let calls = 0;
  const comparison = await compareResearchMaterials(single, { analyzeText: async () => { calls++; throw new Error("A single material is not a comparison request."); } });
  assert.equal(comparison.status, "unavailable"); assert.equal(calls, 0); assert.ok(comparison.errors.some(e => e.code === "INVALID_REQUEST"));
  const duplicates: ComparisonInput[] = [{ kind: "video", result: video() }, { kind: "video", result: video() }];
  const deps = { analyzeText: async (prompt: string) => JSON.stringify({ comparisons: [answerPoint(catalog(prompt))] }) };
  const [answer, compared] = await Promise.all([answerResearchMaterials(request(duplicates), deps), compareResearchMaterials(request(duplicates), deps)]);
  assert.equal(answer.status, "complete"); assert.equal(compared.status, "partial");
  assert.equal(answer.source_independence, "not_established"); assert.equal(compared.source_independence, "not_established");
});
