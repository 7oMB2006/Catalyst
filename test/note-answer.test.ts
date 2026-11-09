import assert from "node:assert/strict";
import test from "node:test";
import type { NoteEvidence } from "../src/note-contracts.js";
import { collectNoteAnswer } from "../src/note-answer.js";

type AnswerResult = Parameters<typeof collectNoteAnswer>[1];
const sharedNotice = "Model interpretation; citation IDs are validated structurally, not semantically.";

function evidence(id: string, page: number | null, kind: NoteEvidence["kind"] = "image_visual"): NoteEvidence {
  return { id, page, kind, content: "Preserved source text.", limitations: ["Original evidence limitation."], source: { platform: "xiaohongshu", note_id: "fixture-note", url: "https://www.xiaohongshu.com/explore/fixture-note", origin: "fixture" } };
}

function fixture(language: string | undefined = "zh", question = "流程图如何交付结果？"): AnswerResult {
  return {
    request: { url: "https://www.xiaohongshu.com/explore/fixture-note", question, language },
    evidence: [evidence("image:24:visual", 24), evidence("image:25:text", 25, "image_text"), evidence("note:body", null, "note_text"), evidence("image:unknown:text", null, "image_text")],
    findings: [], analysis: "stale answer", warnings: ["Preserved source warning."],
  };
}

const point = { statement: "通过检查后写审查状态。", evidence_ids: ["image:24:visual"], limitations: ["箭头细节尚未独立核验。"] };

test("note answers use the same accepted findings regardless of a missing or misleading legacy analysis", () => {
  let expected: string | null = null;
  for (const analysis of [undefined, null, "", "本次只查看第24页，尚未核验。", "具体答案请看 findings。", "未通过检查后立即发布，LEGACY-CONTRADICTION-MARKER。", { unexpected: "LEGACY-OBJECT-MARKER" }]) {
    const result = fixture();
    assert.equal(collectNoteAnswer(JSON.stringify({ analysis, findings: [point] }), result), true);
    assert.match(result.analysis!, /通过检查后写审查状态。/);
    assert.match(result.analysis!, /第 24 页 \(image:24:visual\)/);
    assert.doesNotMatch(result.analysis!, /LEGACY-|具体答案请看|本次只查看/);
    expected ??= result.analysis;
    assert.equal(result.analysis, expected, "legacy analysis must not affect the composed answer");
    assert.deepEqual(result.warnings, ["Preserved source warning."]);
    assert.equal(result.findings[0].verification, "unverified");
    assert.deepEqual(result.findings[0].limitations, [...point.limitations, sharedNotice]);
  }
});

test("answers preserve original pages, body references, no-page evidence and point uncertainty", () => {
  const result = fixture();
  const points = [
    { statement: "两页共同描述交付步骤。", evidence_ids: ["image:25:text", "image:24:visual", "image:25:text"], limitations: ["  图例不清楚。  ", "图例不清楚。", "正文没有解释失败分支。"] },
    { statement: "正文提出自动化目标。", evidence_ids: ["note:body", "image:unknown:text"], limitations: ["正文陈述未经独立核验。"] },
  ];
  assert.equal(collectNoteAnswer(JSON.stringify({ findings: points }), result), true);
  assert.match(result.analysis!, /第 25 页 \(image:25:text\)；第 24 页 \(image:24:visual\)/);
  assert.match(result.analysis!, /笔记正文 \(note:body\)；无页码 \(image:unknown:text\)/);
  assert.doesNotMatch(result.analysis!, /第 null 页|第 1 页|第 2 页/);
  assert.match(result.analysis!, /正文没有解释失败分支。/);
  assert.match(result.analysis!, /正文陈述未经独立核验。/);
  assert.equal(result.analysis!.split("图例不清楚。").length - 1, 1, "identical limitations within a point are rendered once");
  assert.deepEqual(result.findings[0].evidence_ids, ["image:25:text", "image:24:visual"]);
  assert.deepEqual(result.findings[0].limitations, [...points[0].limitations, sharedNotice], "rendering must not rewrite the public point limitations");
});

test("a common interpretation notice is rendered once without altering public findings", () => {
  const result = fixture("en", "How does this process work?");
  const points = [point, { ...point, statement: "The next step remains uncertain.", limitations: [sharedNotice, "The next step is unclear."] }];
  assert.equal(collectNoteAnswer(JSON.stringify({ findings: points }), result), true);
  assert.equal(result.analysis!.split("Findings are unverified model interpretations.").length - 1, 1);
  assert.doesNotMatch(result.analysis!, /Model interpretation; citation IDs/);
  assert.match(result.analysis!, /The next step is unclear./);
  assert.match(result.analysis!, /page 24 \(image:24:visual\)/);
  assert.equal(result.findings[1].verification, "unverified");
  assert.equal(result.findings[1].limitations.filter((item) => item === sharedNotice).length, 2);
});

test("Chinese public labels follow the requested language, with question detection only when unspecified", () => {
  for (const language of ["zh", "zh-CN", "zh_TW", "Chinese", "中文", undefined]) {
    const result = fixture(language);
    if (language === undefined) delete result.request.language;
    assert.equal(collectNoteAnswer(JSON.stringify({ findings: [point] }), result), true);
    assert.match(result.analysis!, /来源: 第 24 页/);
    assert.match(result.analysis!, /说明：要点为模型解释/);
    assert.doesNotMatch(result.analysis!, /Sources:|Note: Findings/);
  }
  const explicitEnglish = fixture("en");
  assert.equal(collectNoteAnswer(JSON.stringify({ findings: [point] }), explicitEnglish), true);
  assert.match(explicitEnglish.analysis!, /Sources: page 24/);
  const englishQuestion = fixture();
  englishQuestion.request = { ...englishQuestion.request, language: undefined, question: "What is visible?" };
  assert.equal(collectNoteAnswer(JSON.stringify({ findings: [point] }), englishQuestion), true);
  assert.match(englishQuestion.analysis!, /Note: Findings/);
});

test("partially valid findings retain only accepted points and report incomplete collection", () => {
  const result = fixture();
  const raw = JSON.stringify({ analysis: "LEGACY-ANSWER-MARKER", findings: [
    { statement: "BAD-CLAIM-MARKER", evidence_ids: ["image:99:visual"], limitations: ["BAD-LIMITATION-MARKER"] },
    point,
    { statement: "MIXED-INVALID-MARKER", evidence_ids: ["image:24:visual", "missing:id"] },
    { statement: "EMPTY-CITATION-MARKER", evidence_ids: [] },
    { statement: "BAD-SHAPE-MARKER", evidence_ids: "image:24:visual" },
  ] });
  assert.equal(collectNoteAnswer(raw, result), false);
  assert.deepEqual(result.findings.map((item) => item.statement), [point.statement]);
  assert.match(result.analysis!, /通过检查后写审查状态。/);
  assert.doesNotMatch(result.analysis!, /LEGACY-|BAD-|MIXED-INVALID|EMPTY-CITATION/);
  assert.match(result.warnings.at(-1)!, /部分答案要点未通过校验/);
  assert.doesNotMatch(result.warnings.join("\n"), /analysis remains|BAD-|LEGACY-/);
  assert.equal(result.warnings[0], "Preserved source warning.");
});

test("malformed or empty responses never fall back to raw text, legacy analysis or stale findings", () => {
  const cases = [
    "RAW-ANSWER-MARKER", "", '{"findings":[{"statement":"RAW-JSON-MARKER"',
    JSON.stringify({ analysis: "LEGACY-ANSWER-MARKER" }),
    JSON.stringify({ analysis: "LEGACY-ANSWER-MARKER", findings: [] }),
    JSON.stringify({ findings: [{ statement: "BAD-CLAIM-MARKER", evidence_ids: ["unknown"] }] }),
    JSON.stringify({ findings: [{ statement: "   ", evidence_ids: ["image:24:visual"] }] }),
    JSON.stringify({ findings: "INVALID-FINDINGS-MARKER" }),
    JSON.stringify([{ statement: "ARRAY-MARKER", evidence_ids: ["image:24:visual"] }]),
    "null", "false", "42",
  ];
  for (const raw of cases) {
    const result = fixture();
    result.findings = [{ id: "stale", statement: "STALE-MARKER", evidence_ids: ["note:body"], limitations: [], verification: "unverified" }];
    assert.equal(collectNoteAnswer(raw, result), false);
    assert.equal(result.analysis, null);
    assert.deepEqual(result.findings, []);
    assert.match(result.warnings.at(-1)!, /未取得具有有效来源引用的答案要点/);
    assert.doesNotMatch(result.warnings.join("\n"), /MARKER|analysis remains|unstructured analysis/);
  }
});

test("a complete fenced object reuses shared collection without accepting the legacy answer", () => {
  const result = fixture();
  const raw = `\`\`\`json\n${JSON.stringify({ findings: [point], analysis: "LEGACY-MARKER" })}\n\`\`\``;
  assert.equal(collectNoteAnswer(raw, result), true);
  assert.match(result.analysis!, /通过检查后写审查状态。/);
  assert.doesNotMatch(result.analysis!, /LEGACY-MARKER/);
});

test("collection and rendering leave the request and original source evidence unchanged", () => {
  const result = fixture();
  const originalRequest = structuredClone(result.request);
  const originalEvidence = structuredClone(result.evidence);
  for (const item of result.evidence) {
    Object.freeze(item.limitations);
    Object.freeze(item.source);
    Object.freeze(item);
  }
  Object.freeze(result.evidence);
  Object.freeze(result.request);
  assert.equal(collectNoteAnswer(JSON.stringify({ findings: [point] }), result), true);
  assert.deepEqual(result.request, originalRequest);
  assert.deepEqual(result.evidence, originalEvidence);
});
