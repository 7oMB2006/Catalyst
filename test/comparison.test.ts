import assert from "node:assert/strict";
import test from "node:test";
import type { ComparisonDependencies, ComparisonEvidence, ComparisonInput, ComparisonPosition, ComparisonRequest, ComparisonResult, PreparedComparison } from "../src/comparison-contracts.js";
import { compareResearchMaterials } from "../src/comparison.js";
import { comparisonResultSchema } from "../src/comparison-schema.js";

const QUESTION = "这些材料如何分配宿主与工具的职责，哪些说法一致，哪些没有涉及？";
const INPUTS: ComparisonInput[] = [
  { kind: "session", session_id: "57e4e2e7-483a-44de-a031-c29f8f553974", label: "Video" },
  { kind: "session", session_id: "104c897f-7826-43e1-be1b-969fbf6d35bc", label: "Note" },
];
const REQUEST: ComparisonRequest = { question: QUESTION, materials: INPUTS, language: "zh" };
const VIDEO_URL = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const NOTE_URL = "https://www.xiaohongshu.com/explore/6ae80a83000000001a0153d3";

function prepared(count = 2): PreparedComparison {
  const evidence: ComparisonEvidence[] = [
    { id: "material:1:e1", material_id: "material:1", original_id: "e1", kind: "asr", basis: "source_text", content: "The host chooses the next action. Tools provide observations.",
      locator: { url: VIDEO_URL, platform: "bilibili", content_id: "BV1DTxXzUEvW", part_id: "38253823575", time_range: { start_seconds: 1200, end_seconds: 1800 }, page: null }, limitations: ["ASR is unverified and only aligned to the supplied interval."] },
    { id: "material:2:e1", material_id: "material:2", original_id: "e1", kind: "image_text", basis: "source_text", content: "工具提供观察结果，宿主选择后续步骤。图中保留人类判断。",
      locator: { url: NOTE_URL, platform: "xiaohongshu", content_id: "6ae80a83000000001a0153d3", part_id: null, time_range: null, page: 24 }, limitations: ["OCR is unverified."] },
  ];
  if (count === 3) evidence.push({ ...structuredClone(evidence[0]), id: "material:3:e1", material_id: "material:3", content: "The operator reviews the proposed action before execution.", locator: { ...evidence[0].locator, content_id: "BV1xx411c7mD", url: "https://www.bilibili.com/video/BV1xx411c7mD/", part_id: "another-part" } });
  return {
    materials: evidence.map((item, index) => ({ id: item.material_id, label: `Material ${index + 1}`, status: "ready", source_key: `${item.locator.platform}:${item.locator.content_id}:${item.locator.part_id ?? "note"}`, source_group: `source:${index + 1}`, duplicate_of: null,
      title: `Fixture source ${index + 1}`, url: item.locator.url, original_question: "A different earlier question", evidence_ids: [item.id], limitations: item.limitations, errors: [] })),
    evidence,
  };
}
function position(value: PreparedComparison, index: number, stance: ComparisonPosition["stance"] = "supports"): ComparisonPosition {
  const material = value.materials[index], evidence = value.evidence.find((e) => e.material_id === material.id);
  return { material_id: material.id, stance, citations: ["supports", "contradicts"].includes(stance) && evidence ? [{ evidence_id: evidence.id, quote: evidence.content.slice(0, 40) }] : [],
    explanation: ["not_addressed", "insufficient"].includes(stance) ? "This claim is not established by the supplied material; this does not establish what the unread source says." : "The supplied quotation expresses this position; interpretation remains unverified." };
}
function row(value: PreparedComparison, stances: ComparisonPosition["stance"][] = value.materials.map(() => "supports")) {
  return { claim: "The host decides the next step while tools provide observations.", positions: stances.map((stance, index) => position(value, index, stance)), limitations: ["Source meaning has not been independently checked."] };
}
function fixture(value = prepared(), response?: unknown) {
  const calls = { prepared: 0, prompts: [] as string[], languages: [] as Array<string | undefined> };
  const dependencies: ComparisonDependencies = {
    prepare: async () => { calls.prepared++; return structuredClone(value); },
    analyzeText: async (prompt, _context, language) => { calls.prompts.push(prompt); calls.languages.push(language); return typeof response === "string" ? response : JSON.stringify(response ?? { comparisons: [row(value)] }); },
  };
  return { dependencies, calls };
}
function assertContract(value: ComparisonResult): void {
  assert.ok(comparisonResultSchema.safeParse(value).success, "every outcome matches the MCP output schema");
  assert.equal(value.source_independence, "not_established");
  assert.ok(value.comparisons.every((entry) => entry.verification === "unverified"));
  const evidence = new Map(value.evidence.map((item) => [item.id, item]));
  assert.equal(evidence.size, value.evidence.length);
  for (const comparison of value.comparisons) for (const material of comparison.positions) for (const citation of material.citations) {
    const source = evidence.get(citation.evidence_id);
    assert.ok(source); assert.equal(source.material_id, material.material_id); assert.ok(source.content.includes(citation.quote));
  }
}
interface QuoteEntry { id: string; material_id: string; evidence_id: string; basis: string; quote: string }
function catalogIn(prompt: string): QuoteEntry[] {
  const marker = "QUOTE CATALOG:\n\n", start = prompt.lastIndexOf(marker);
  assert.notEqual(start, -1, "production prompts expose code-selected quote IDs");
  return JSON.parse(prompt.slice(start + marker.length));
}
function catalogRow(value: PreparedComparison, catalog: QuoteEntry[], selectLast = false) {
  return {
    claim: "The host chooses the next action while tools provide observations.",
    positions: value.materials.map((material) => {
      const entries = catalog.filter((entry) => entry.material_id === material.id), quote = selectLast ? entries.at(-1) : entries[0];
      assert.ok(quote);
      return { material_id: material.id, stance: "supports", citation_ids: [quote.id], explanation: "The selected supplied excerpt expresses this position; interpretation remains unverified." };
    }),
    limitations: ["Only the selected, already-read scope is available."],
  };
}

test("catalog IDs resolve to exact original excerpts and evidence IDs before output validation", async () => {
  const value = prepared(), next = fixture(value);
  let seen: QuoteEntry[] = [];
  next.dependencies.analyzeText = async (prompt) => {
    next.calls.prompts.push(prompt); seen = catalogIn(prompt);
    assert.equal(seen.length, 2); assert.ok(seen.every((entry) => entry.quote.length <= 180));
    return JSON.stringify({ comparisons: [catalogRow(value, seen)] });
  };
  const result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "complete"); assert.equal(result.comparisons[0].relation, "shared");
  for (const position of result.comparisons[0].positions) {
    const source = value.evidence.find((entry) => entry.material_id === position.material_id)!;
    assert.deepEqual(position.citations, [{ evidence_id: source.id, quote: source.content }]);
    assert.equal("citation_ids" in position, false, "internal selection IDs are not public source citations");
  }
  assert.equal(result.evidence[1].locator.page, 24); assert.deepEqual(result.evidence[0].locator.time_range, value.evidence[0].locator.time_range); assertContract(result);
});

test("unknown catalog IDs discard the entire row and retain a valid catalog comparison", async () => {
  const value = prepared(), next = fixture(value);
  next.dependencies.analyzeText = async (prompt) => {
    const catalog = catalogIn(prompt), invalid = catalogRow(value, catalog);
    invalid.claim = "An unknown catalog reference must never be accepted."; invalid.positions[0].citation_ids = ["quote:unknown"];
    return JSON.stringify({ comparisons: [invalid, catalogRow(value, catalog)] });
  };
  const result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.comparisons.length, 1);
  assert.doesNotMatch(result.comparisons[0].claim, /unknown catalog reference/); assert.ok(result.errors.length); assertContract(result);
});

test("a catalog selection owned by another material cannot become a cross-source citation", async () => {
  const value = prepared(), next = fixture(value);
  next.dependencies.analyzeText = async (prompt) => {
    const catalog = catalogIn(prompt), invalid = catalogRow(value, catalog);
    invalid.claim = "A foreign material's excerpt must not support this row.";
    invalid.positions[0].citation_ids = [catalog.find((entry) => entry.material_id === value.materials[1].id)!.id];
    return JSON.stringify({ comparisons: [invalid, catalogRow(value, catalog)] });
  };
  const result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.comparisons.length, 1);
  assert.doesNotMatch(result.comparisons[0].claim, /foreign material/); assert.ok(result.errors.length); assertContract(result);
});

test("long note excerpts split into bounded catalog entries without changing their original page", async () => {
  const value = prepared(); value.evidence[1].content = `${"这段材料说明工具返回观察，宿主决定后续步骤。".repeat(30)}末尾页内标记。`;
  const next = fixture(value); let seen: QuoteEntry[] = [];
  next.dependencies.analyzeText = async (prompt) => {
    seen = catalogIn(prompt);
    assert.ok(seen.filter((entry) => entry.material_id === value.materials[1].id).length > 1);
    assert.ok(seen.every((entry) => entry.quote.length > 0 && entry.quote.length <= 180));
    return JSON.stringify({ comparisons: [catalogRow(value, seen, true)] });
  };
  const result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "complete");
  const cited = result.comparisons[0].positions[1].citations[0], original = result.evidence.find((entry) => entry.id === cited.evidence_id);
  assert.ok(original); assert.equal(original.original_id, "e1"); assert.equal(original.locator.page, 24); assert.equal(original.locator.time_range, null);
  assert.ok(original.content.includes(cited.quote)); assert.match(cited.quote, /末尾页内标记/); assertContract(result);
});

test("mixed supplied video and note evidence preserves scoped IDs and time/page locators with one text call", async () => {
  const original = prepared(), before = structuredClone(original), next = fixture(original), request = structuredClone(REQUEST), originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("Comparison must not fetch source material or media."); }) as typeof fetch;
  try {
    const result = await compareResearchMaterials(request, next.dependencies);
    assert.equal(result.status, "complete"); assert.equal(next.calls.prepared, 1); assert.equal(next.calls.prompts.length, 1); assert.equal(fetches, 0);
    assert.equal(result.processing.model_calls, 1); assert.deepEqual(next.calls.languages, ["zh"]);
    assert.equal(result.comparisons[0].relation, "shared");
    assert.deepEqual(result.evidence.map((item) => item.original_id), ["e1", "e1"]);
    assert.deepEqual(result.evidence[0].locator.time_range, { start_seconds: 1200, end_seconds: 1800 }); assert.equal(result.evidence[0].locator.page, null);
    assert.equal(result.evidence[1].locator.page, 24); assert.equal(result.evidence[1].locator.time_range, null);
    assert.ok(next.calls.prompts[0].includes(QUESTION)); assert.ok(next.calls.prompts[0].includes(original.evidence[0].content)); assert.ok(next.calls.prompts[0].includes(original.evidence[1].content));
    assert.deepEqual(original, before); assert.deepEqual(request, REQUEST); assertContract(result);
  } finally { globalThis.fetch = originalFetch; }
});

test("relation is derived from supplied positions rather than free-form model analysis", async (t) => {
  for (const [name, stances, relation] of [
    ["two agreeing sources", ["supports", "supports"], "shared"],
    ["two sources reject the claim", ["contradicts", "contradicts"], "shared"],
    ["opposing positions", ["supports", "contradicts"], "disputed"],
    ["one source and one unaddressed", ["supports", "not_addressed"], "single_source"],
    ["only evidence gaps", ["insufficient", "not_addressed"], "insufficient"],
  ] as const) await t.test(name, async () => {
    const value = prepared(), next = fixture(value, { comparisons: [row(value, [...stances])], analysis: "UNSUPPORTED_FREE_FORM_FINAL_ANSWER" });
    const result = await compareResearchMaterials(REQUEST, next.dependencies);
    assert.equal(result.comparisons.length, 1); assert.equal(result.comparisons[0].relation, relation);
    assert.doesNotMatch(result.analysis ?? "", /UNSUPPORTED_FREE_FORM_FINAL_ANSWER/); assertContract(result);
  });
});

test("duplicate source groups do not count as two independent supporting sources", async () => {
  const value = prepared(); value.materials[1].source_group = value.materials[0].source_group; value.materials[1].duplicate_of = value.materials[0].id;
  const next = fixture(value), result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.comparisons[0].relation, "single_source"); assertContract(result);
});

test("unavailable material is kept as an explicit evidence gap while useful source positions survive", async () => {
  const value = prepared(); value.materials[1].status = "unavailable"; value.materials[1].evidence_ids = []; value.evidence = value.evidence.slice(0, 1);
  const next = fixture(value, { comparisons: [{ ...row(value, ["supports"]), positions: [position(value, 0)] }] });
  const result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.materials[1].status, "unavailable");
  assert.equal(result.comparisons[0].relation, "single_source");
  const gap = result.comparisons[0].positions.find((item) => item.material_id === value.materials[1].id);
  assert.ok(gap); assert.equal(gap.stance, "insufficient"); assert.deepEqual(gap.citations, []); assertContract(result);
});

test("no usable evidence returns unavailable without invoking the provider", async () => {
  const value = prepared(); value.evidence = [];
  for (const item of value.materials) { item.status = "unavailable"; item.evidence_ids = []; }
  const next = fixture(value), result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.comparisons, []); assert.equal(next.calls.prompts.length, 0); assert.equal(result.processing.model_calls, 0); assertContract(result);
});

test("partial material remains partial even when a model returns well-formed agreement", async () => {
  const value = prepared(); value.materials[1].status = "partial"; value.materials[1].limitations.push("Only page 24 was provided.");
  const next = fixture(value), result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.comparisons[0].relation, "shared"); assertContract(result);
});

test("invalid citation or position rows are dropped as a whole while another valid row is retained", async (t) => {
  const mutations: Array<[string, (entry: ReturnType<typeof row>, value: PreparedComparison) => void]> = [
    ["unknown evidence", (entry) => { entry.positions[0].citations[0].evidence_id = "missing:evidence"; }],
    ["cross-material evidence", (entry, value) => { entry.positions[0].citations[0] = { evidence_id: value.evidence[1].id, quote: value.evidence[1].content.slice(0, 10) }; }],
    ["missing exact quotation", (entry) => { entry.positions[0].citations[0].quote = "A conclusion absent from the supplied text."; }],
    ["empty quotation", (entry) => { entry.positions[0].citations[0].quote = ""; }],
    ["oversize quotation", (entry) => { entry.positions[0].citations[0].quote = "a".repeat(501); }],
    ["support without citation", (entry) => { entry.positions[0].citations = []; }],
    ["missing usable material position", (entry) => { entry.positions.pop(); }],
    ["duplicate material position", (entry) => { entry.positions[1] = structuredClone(entry.positions[0]); }],
    ["unknown material", (entry) => { entry.positions[1].material_id = "material:unknown"; }],
    ["unaddressed with citation", (entry) => { entry.positions[0].stance = "not_addressed"; }],
    ["insufficient with citation", (entry) => { entry.positions[0].stance = "insufficient"; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const value = prepared(), invalid = row(value); invalid.claim = "This invalid comparison row must be discarded."; mutate(invalid, value);
    const next = fixture(value, { comparisons: [invalid, row(value)] }), result = await compareResearchMaterials(REQUEST, next.dependencies);
    assert.equal(result.status, "partial"); assert.equal(result.comparisons.length, 1); assert.notEqual(result.comparisons[0].claim, invalid.claim);
    assert.ok(result.errors.length || result.warnings.length); assertContract(result);
  });
});

test("model support for unavailable material cannot be accepted as an evidential comparison", async () => {
  const value = prepared(); value.materials[1].status = "unavailable";
  const next = fixture(value, { comparisons: [row(value)] }), result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.comparisons, []); assertContract(result);
});

test("a quote assembled from different pages cannot be attributed to a single page", async () => {
  const value = prepared(), first = value.evidence[1];
  value.evidence.push({ ...structuredClone(first), id: "material:2:page25", original_id: "page25", content: "The operator approves the final action.", locator: { ...first.locator, page: 25 } });
  value.materials[1].evidence_ids.push("material:2:page25");
  const invalid = row(value);
  invalid.positions[1].citations[0].quote = first.content + "\n" + value.evidence[2].content;
  const result = await compareResearchMaterials(REQUEST, fixture(value, { comparisons: [invalid, row(value)] }).dependencies);
  assert.equal(result.status, "partial"); assert.equal(result.comparisons.length, 1);
  assert.ok(result.errors.some((e) => e.code === "INVALID_CITATION" && /exact excerpt/.test(e.message)));
  assertContract(result);
});

test("quote catalog boundaries preserve supplementary Unicode characters", async () => {
  const value = prepared(); value.evidence[0].content = "a".repeat(179) + "😀" + " after the boundary";
  const next = fixture(value);
  next.dependencies.analyzeText = async (prompt) => {
    const catalog = JSON.parse(prompt.slice(prompt.lastIndexOf("QUOTE CATALOG:\n\n") + "QUOTE CATALOG:\n\n".length)) as Array<{id:string;material_id:string;quote:string}>;
    for (const q of catalog) for (const char of q.quote) assert.ok(char.length > 1 || !/[\ud800-\udfff]/.test(char), "no isolated surrogate enters a citation");
    return JSON.stringify({ comparisons: [{ ...row(value), positions: value.materials.map((m) => ({ material_id: m.id, stance: "supports", citation_ids: [catalog.find((q) => q.material_id === m.id)!.id], explanation: "Fixture catalog selection." })) }] });
  };
  const result = await compareResearchMaterials(REQUEST, next.dependencies);
  assert.equal(result.status, "complete"); assertContract(result);
});

test("malformed provider output never becomes a free-form final answer", async (t) => {
  for (const raw of ["not JSON", '{"comparisons":', JSON.stringify({ comparisons: [] })]) await t.test(raw, async () => {
    const next = fixture(prepared(), raw), result = await compareResearchMaterials(REQUEST, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.deepEqual(result.comparisons, []); assert.equal(next.calls.prompts.length, 1);
    assert.ok(result.errors.length || result.warnings.length); assertContract(result);
  });
});

test("a configured comparison cap bounds the accepted response and the provider prompt", async () => {
  const value = prepared(), entries = [row(value), { ...row(value), claim: "A second comparison outside the requested cap." }];
  const next = fixture(value, { comparisons: entries }), result = await compareResearchMaterials({ ...REQUEST, maxComparisons: 1 }, next.dependencies);
  assert.ok(result.comparisons.length <= 1); assert.ok(!result.comparisons.some((item) => item.claim === entries[1].claim)); assertContract(result);
});

test("invalid inputs and budgets reject before preparation or paid work", async (t) => {
  const cases: Array<[string, unknown]> = [
    ["short question", { ...REQUEST, question: "ok" }], ["empty question", { ...REQUEST, question: " " }],
    ["long question", { ...REQUEST, question: "x".repeat(2001) }],
    ["one material", { ...REQUEST, materials: INPUTS.slice(0, 1) }], ["four materials", { ...REQUEST, materials: [...INPUTS, ...INPUTS] }],
    ["invalid timeout", { ...REQUEST, timeoutSeconds: 0 }], ["excess timeout", { ...REQUEST, timeoutSeconds: 301 }],
    ["zero row budget", { ...REQUEST, maxComparisons: 0 }], ["excess row budget", { ...REQUEST, maxComparisons: 9 }],
    ["fractional row budget", { ...REQUEST, maxComparisons: 1.5 }],
  ];
  for (const [name, input] of cases) await t.test(name, async () => {
    const next = fixture(), result = await compareResearchMaterials(input as ComparisonRequest, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.equal(next.calls.prepared, 0); assert.equal(next.calls.prompts.length, 0); assert.ok(result.errors.length); assertContract(result);
  });
});

test("oversize input and prepared context stop before provider work", async (t) => {
  await t.test("input JSON exceeds two MiB", async () => {
    const input: ComparisonRequest = { ...REQUEST, materials: [{ ...INPUTS[0], label: "x".repeat(2 * 1024 * 1024) }, INPUTS[1]] };
    const next = fixture(), result = await compareResearchMaterials(input, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.equal(next.calls.prepared, 0); assert.equal(next.calls.prompts.length, 0); assert.ok(result.errors.length); assertContract(result);
  });
  await t.test("normalized context exceeds text budget", async () => {
    const value = prepared(); value.evidence[0].content = "a".repeat(200_001);
    const next = fixture(value), result = await compareResearchMaterials(REQUEST, next.dependencies);
    assert.equal(result.status, "unavailable"); assert.equal(next.calls.prepared, 1); assert.equal(next.calls.prompts.length, 0); assert.ok(result.errors.length); assertContract(result);
  });
});

test("pre-cancellation performs neither preparation nor model work", async () => {
  const next = fixture(), controller = new AbortController(); controller.abort(new DOMException("Fixture cancellation", "AbortError"));
  const result = await compareResearchMaterials(REQUEST, next.dependencies, controller.signal);
  assert.equal(result.status, "unavailable"); assert.equal(next.calls.prepared, 0); assert.equal(next.calls.prompts.length, 0); assert.ok(result.errors.some((error) => error.code === "CANCELLED")); assertContract(result);
});

test("cancellation after preparation prevents a model call", async () => {
  const next = fixture(), controller = new AbortController(), prepare = next.dependencies.prepare;
  next.dependencies.prepare = async (...args) => { const value = await prepare(...args); controller.abort(new DOMException("Fixture cancellation", "AbortError")); return value; };
  const result = await compareResearchMaterials(REQUEST, next.dependencies, controller.signal);
  assert.equal(next.calls.prepared, 1); assert.equal(next.calls.prompts.length, 0); assert.equal(result.processing.model_calls, 0); assert.ok(result.errors.some((error) => error.code === "CANCELLED")); assertContract(result);
});

test("the deadline bounds a noncooperative provider promise", { timeout: 5000 }, async () => {
  const next = fixture(), analyze = next.dependencies.analyzeText;
  next.dependencies.analyzeText = async (...args) => { await analyze(...args); return new Promise<string>(() => {}); };
  const start = Date.now(), result = await compareResearchMaterials({ ...REQUEST, timeoutSeconds: 1 }, next.dependencies);
  assert.ok(Date.now() - start < 4000); assert.equal(result.status, "unavailable"); assert.equal(next.calls.prompts.length, 1);
  assert.ok(result.errors.some((error) => error.code === "TIMEOUT")); assertContract(result);
});
