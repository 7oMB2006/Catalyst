import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExecutionContext, ResearchResult } from "../src/contracts.js";
import type { NoteDependencies, NoteResearchRequest, NoteResearchResult, XiaohongshuNoteSource, XiaohongshuResearchResult } from "../src/note-contracts.js";
import { researchXiaohongshuNote } from "../src/note-research.js";
import { noteResearchResultSchema, xiaohongshuResearchResultSchema } from "../src/note-result-schema.js";

const NOTE_ID = "6ae80a83000000001a0153d3";
const PUBLIC_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;
const INTERNAL_URL = `${PUBLIC_URL}?xsec_token=fixture-private-share-token&xsec_source=app_share`;
const request: NoteResearchRequest = {
  url: `推荐一篇图文 ${INTERNAL_URL}，复制后打开小红书查看！`,
  question: "What does the author recommend?", language: "zh", timeoutSeconds: 20,
};

function source(pageCount = 3): XiaohongshuNoteSource {
  return {
    id: NOTE_ID, sourceUrl: INTERNAL_URL, canonicalUrl: INTERNAL_URL,
    title: "Fixture article", description: "Platform body: retain human judgment.", uploader: "Fixture author",
    contentType: "image_note", pages: Array.from({ length: pageCount }, (_, i) => ({
      index: i + 1, url: `https://sns-webpic-qc.xhscdn.com/fixture-private-signature/page-${i + 1}.jpg`, width: 1440, height: 2400,
    })),
  };
}

function noteResult(wrapper: XiaohongshuResearchResult): NoteResearchResult {
  xiaohongshuResearchResultSchema.parse(wrapper);
  assert.equal(wrapper.content_type, "image_note");
  assert.ok(wrapper.result && "note" in wrapper.result);
  noteResearchResultSchema.parse(wrapper.result);
  return wrapper.result;
}

async function fixture(pageCount = 3) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-note-engine-"));
  const calls = {
    resolve: 0, acquire: [] as number[][], ocr: [] as number[][], images: [] as number[][],
    textPrompts: [] as string[], imagePrompts: [] as string[], contexts: [] as ExecutionContext[], disposed: 0,
  };
  let textResponse: string | undefined;
  let imageResponse: ((pages: number[], call: number) => unknown) | undefined;
  const value = source(pageCount);
  const dependencies: NoteDependencies = {
    resolve: async (_request, context) => { calls.resolve++; calls.contexts.push(context); return structuredClone(value); },
    acquire: async (_source, pages, context) => {
      calls.acquire.push([...pages]); calls.contexts.push(context);
      const assets = await Promise.all(pages.map(async (index) => {
        const filename = path.join(directory, `page-${index}.jpg`);
        await fs.writeFile(filename, "fixture image bytes; injected providers never decode these");
        return { index, path: filename, width: 1440, height: 2400 };
      }));
      return { directory, pages: assets, bytes: pages.length * 100, dispose: async () => { calls.disposed++; await fs.rm(directory, { recursive: true, force: true }); } };
    },
    ocr: async (pages, context) => {
      calls.ocr.push(pages.map((page) => page.index)); calls.contexts.push(context);
      return pages.map((page) => ({ page: page.index, text: `Page ${page.index} source text: act on events and preserve human judgment.`, method: "apple_vision" as const, warnings: [] }));
    },
    analyzeImages: async (paths, prompt, context) => {
      const pages = paths.map((filename) => Number(path.basename(filename).match(/page-(\d+)/)![1]));
      calls.images.push(pages); calls.imagePrompts.push(prompt); calls.contexts.push(context);
      const response = imageResponse ? imageResponse(pages, calls.images.length) : { pages: pages.map((page) => ({ page, observation: `Page ${page} shows a workflow diagram.` })) };
      return typeof response === "string" ? response : JSON.stringify(response);
    },
    analyzeText: async (prompt, context) => {
      calls.textPrompts.push(prompt); calls.contexts.push(context);
      const id = prompt.match(/image:\d+:(?:text|visual)/)?.[0] ?? "note:body";
      return textResponse ?? JSON.stringify({ findings: [{ statement: "Agents act on events while a human makes key decisions.", evidence_ids: [id], limitations: [] }] });
    },
  };
  return {
    directory, value, calls, dependencies,
    respond: (value: unknown) => { textResponse = typeof value === "string" ? value : JSON.stringify(value); },
    respondImages: (response: (pages: number[], call: number) => unknown) => { imageResponse = response; },
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("image-note text research covers all 32 pages and preserves page-based provenance without exposing acquisition URLs", async () => {
  const fake = await fixture(32);
  try {
    const result = noteResult(await researchXiaohongshuNote(request, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.equal(result.note?.imageCount, 32);
    assert.equal(result.note?.canonicalUrl, PUBLIC_URL);
    assert.equal(result.request.url, PUBLIC_URL);
    assert.deepEqual(fake.calls.acquire, [Array.from({ length: 32 }, (_, i) => i + 1)]);
    assert.deepEqual(fake.calls.ocr.flat(), Array.from({ length: 32 }, (_, i) => i + 1));
    assert.deepEqual(result.processing.selected_pages, Array.from({ length: 32 }, (_, i) => i + 1));
    assert.deepEqual(result.processing.processed_pages, Array.from({ length: 32 }, (_, i) => i + 1));
    assert.equal(result.processing.total_pages, 32);
    assert.equal(result.evidence.filter((item) => item.kind === "image_text").length, 32);
    assert.ok(result.evidence.some((item) => item.id === "note:body" && item.page === null));
    assert.ok(result.evidence.some((item) => item.id === "image:32:text" && item.page === 32));
    assert.match(fake.calls.textPrompts.at(-1)!, /Page 32 source text/);
    assert.equal(fake.calls.images.length, 0, "text mode must not add a visual interpretation call");
    assert.equal(result.findings[0].verification, "unverified");
    assert.equal(result.processing.usage, null);
    for (const evidence of result.evidence) {
      assert.equal(evidence.source.note_id, NOTE_ID);
      assert.equal(evidence.source.url, PUBLIC_URL);
      assert.equal("time_range" in evidence, false, "image pages must not acquire invented video timestamps");
    }
    assert.doesNotMatch(JSON.stringify(result), /fixture-private|xsec_token|xsec_source|xhscdn|page-\d+\.jpg/);
    assert.doesNotMatch(fake.calls.textPrompts.join("\n"), /fixture-private|xsec_token|xhscdn/);
    assert.equal(fake.calls.disposed, 1);
    assert.equal(await fs.access(fake.directory).then(() => true, () => false), false);
  } finally { await fake.cleanup(); }
});

test("an explicit page interval restricts acquisition, OCR and evidence while preserving original page numbers", async () => {
  const fake = await fixture(32);
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, startPage: 29, endPage: 32 }, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.deepEqual(fake.calls.acquire, [[29, 30, 31, 32]]);
    assert.deepEqual(fake.calls.ocr.flat(), [29, 30, 31, 32]);
    assert.deepEqual(result.processing.processed_pages, [29, 30, 31, 32]);
    assert.deepEqual(result.evidence.map((item) => item.page), [29, 30, 31, 32]);
    assert.equal(result.evidence.some((item) => item.id === "note:body"), false);
    assert.match(fake.calls.textPrompts.at(-1)!, /Page 29 source text/);
    assert.doesNotMatch(fake.calls.textPrompts.at(-1)!, /Page 1 source text|Platform body:/);
  } finally { await fake.cleanup(); }
});

test("vision and combined research use bounded image batches and keep observations distinct from OCR", async () => {
  for (const mode of ["vision", "combined"] as const) {
    const fake = await fixture(9);
    try {
      const result = noteResult(await researchXiaohongshuNote({ ...request, mode }, fake.dependencies));
      assert.equal(result.status, "complete", JSON.stringify(result.errors));
      assert.equal(fake.calls.images.length, 3);
      assert.ok(fake.calls.images.every((pages) => pages.length <= 4));
      assert.deepEqual(fake.calls.images.flat(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.equal(result.evidence.filter((item) => item.kind === "image_visual").length, 9);
      assert.ok(result.evidence.some((item) => item.id === "image:9:visual" && item.page === 9));
      assert.equal(result.evidence.filter((item) => item.kind === "image_text").length, mode === "combined" ? 9 : 0);
      assert.equal(fake.calls.ocr.length > 0, mode === "combined");
      assert.deepEqual(result.processing.processed_pages, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.doesNotMatch(fake.calls.imagePrompts.join("\n"), /fixture-private|xsec_token|xhscdn/);
      assert.equal(fake.calls.disposed, 1);
    } finally { await fake.cleanup(); }
  }
});

test("selected-page visual prompts and returned evidence use the original page number instead of restarting at one", async () => {
  const fake = await fixture(32);
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 24, endPage: 24 }, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.deepEqual(fake.calls.acquire, [[24]]);
    assert.deepEqual(fake.calls.images, [[24]]);
    assert.equal(fake.calls.imagePrompts.length, 1);
    assert.match(fake.calls.imagePrompts[0], /"position":1,"source_page":24/);
    assert.deepEqual(result.evidence.map((item) => [item.id, item.page]), [["image:24:visual", 24]]);
    assert.deepEqual(result.findings[0].evidence_ids, ["image:24:visual"]);
    assert.deepEqual(result.processing.processed_pages, [24]);
  } finally { await fake.cleanup(); }
});

test("batch-local image indexes map back to the selected original page", async () => {
  const fake = await fixture(32);
  fake.dependencies.analyzeImages = async (_paths, prompt) => {
    assert.match(prompt, /"position"\s*:\s*1\s*,\s*"source_page"\s*:\s*24/);
    return JSON.stringify({ pages: [{ image_index: 1, observation: "A CI workflow diagram is visible." }] });
  };
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 24, endPage: 24 }, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.deepEqual(result.processing.processed_pages, [24]);
    assert.deepEqual(result.evidence.map((item) => [item.id, item.page]), [["image:24:visual", 24]]);
    assert.deepEqual(result.findings[0].evidence_ids, ["image:24:visual"]);
  } finally { await fake.cleanup(); }
});

test("an ordered observation for a single selected image binds to original page 24", async () => {
  const fake = await fixture(32);
  fake.respondImages(() => ({ observations: ["A CI workflow diagram is visible."] }));
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 24, endPage: 24 }, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.deepEqual(fake.calls.images, [[24]]);
    assert.deepEqual(result.processing.selected_pages, [24]);
    assert.deepEqual(result.processing.processed_pages, [24]);
    assert.deepEqual(result.evidence.map((item) => [item.id, item.page, item.content]), [
      ["image:24:visual", 24, "A CI workflow diagram is visible."],
    ]);
    assert.deepEqual(result.findings[0].evidence_ids, ["image:24:visual"]);
    assert.equal(fake.calls.disposed, 1);
  } finally { await fake.cleanup(); }
});

test("ordered observations map each new batch position to its original page across a four-image batch and one-image tail", async () => {
  const fake = await fixture(32);
  fake.respondImages((pages) => ({ observations: pages.map((page) => `Visible source content from page ${page}.`) }));
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 24, endPage: 28 }, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.deepEqual(fake.calls.images, [[24, 25, 26, 27], [28]]);
    assert.deepEqual(result.processing.processed_pages, [24, 25, 26, 27, 28]);
    assert.deepEqual(result.evidence.map((item) => [item.id, item.page, item.content]), [24, 25, 26, 27, 28].map((page) => [
      `image:${page}:visual`, page, `Visible source content from page ${page}.`,
    ]));
    assert.equal(result.note?.imageCount, 32);
    assert.equal(result.evidence.some((item) => item.page !== null && (item.page < 24 || item.page > 28)), false);
    assert.match(fake.calls.textPrompts[0], /Visible source content from page 28/);
  } finally { await fake.cleanup(); }
});

test("invalid ordered visual output rejects the entire batch before retaining evidence or requesting a summary", async (t) => {
  const observations = ["First visible diagram.", "Second visible diagram."];
  const cases: Array<[string, unknown]> = [
    ["too few observations", { observations: observations.slice(0, 1) }],
    ["too many observations", { observations: [...observations, "An unrequested image."] }],
    ["observations is not an array", { observations: "A single string cannot cover both images." }],
    ["an observation is an object", { observations: [observations[0], { observation: observations[1] }] }],
    ["an observation is a number", { observations: [observations[0], 24] }],
    ["an observation is null", { observations: [observations[0], null] }],
    ["an observation is empty", { observations: [observations[0], ""] }],
    ["an observation is whitespace", { observations: [observations[0], " \n\t "] }],
    ["unexpected top-level field", { observations, page: 24 }],
    ["mixed ordered and legacy formats", { observations, pages: [{ page: 23, observation: "Legacy value must not be retained." }] }],
    ["top-level array", observations],
    ["malformed JSON", '{"observations":["First visible diagram.","Second visible diagram."]'],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const fake = await fixture(32);
      fake.respondImages(() => response);
      try {
        const wrapper = await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 23, endPage: 24 }, fake.dependencies);
        const result = noteResult(wrapper);
        assert.equal(result.status, "partial");
        assert.equal(wrapper.status, "partial");
        assert.ok(result.errors.some((item) => item.stage === "vision"));
        assert.deepEqual(result.evidence, [], "no observation from a rejected positional batch may acquire a source page");
        assert.deepEqual(result.processing.processed_pages, []);
        assert.deepEqual(result.findings, []);
        assert.equal(result.analysis, null);
        assert.equal(fake.calls.textPrompts.length, 0, "there is no accepted evidence to summarize");
        assert.deepEqual(fake.calls.images, [[23, 24]]);
        assert.equal(fake.calls.disposed, 1);
      } finally { await fake.cleanup(); }
    });
  }
});

test("a rejected later ordered batch retains earlier visual evidence and any existing OCR", async (t) => {
  for (const mode of ["vision", "combined"] as const) {
    await t.test(mode, async () => {
      const fake = await fixture(32);
      fake.respondImages((pages, call) => ({ observations: call === 1
        ? pages.map((page) => `Accepted visual detail from page ${page}.`)
        : ["Rejected tail detail.", "An extra observation invalidates this batch."] }));
      try {
        const result = noteResult(await researchXiaohongshuNote({ ...request, mode, startPage: 24, endPage: 28 }, fake.dependencies));
        assert.equal(result.status, "partial");
        assert.ok(result.errors.some((item) => item.stage === "vision"));
        assert.deepEqual(fake.calls.images, [[24, 25, 26, 27], [28]]);
        assert.deepEqual(result.evidence.filter((item) => item.kind === "image_visual").map((item) => item.page), [24, 25, 26, 27]);
        assert.deepEqual(result.evidence.filter((item) => item.kind === "image_text").map((item) => item.page), mode === "combined" ? [24, 25, 26, 27, 28] : []);
        assert.deepEqual(result.processing.processed_pages, mode === "combined" ? [24, 25, 26, 27, 28] : [24, 25, 26, 27]);
        assert.equal(fake.calls.textPrompts.length, 1, "accepted earlier evidence can still support a partial answer");
        assert.match(fake.calls.textPrompts[0], /Accepted visual detail from page 27/);
        assert.doesNotMatch(fake.calls.textPrompts[0], /Rejected tail detail|extra observation/);
        assert.doesNotMatch(JSON.stringify(result.evidence), /Rejected tail detail|extra observation/);
        assert.equal(fake.calls.disposed, 1);
      } finally { await fake.cleanup(); }
    });
  }
});

test("the default visual provider requests an exact ordered batch schema and keeps the public page evidence contract", async (t) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6S8AAAAASUVORK5CYII=", "base64");
  const settings = {
    CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_API_KEY: "fixture-stepfun-key",
    STEPFUN_BASE_URL: "https://api.stepfun.com/v1", GEMINI_API_KEY: "fixture-gemini-key",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  try {
    for (const [key, value] of Object.entries(settings)) process.env[key] = value;
    for (const [provider, responseFormat] of [["stepfun", "ordered"], ["gemini", "ordered"], ["stepfun", "legacy"]] as const) {
      await t.test(`${provider}: ${responseFormat} output`, async () => {
        process.env.CODEX_VIDEO_PROVIDER = provider;
        const fake = await fixture(32);
        const acquire = fake.dependencies.acquire;
        fake.dependencies.acquire = async (...args) => {
          const images = await acquire(...args);
          await Promise.all(images.pages.map((page) => fs.writeFile(page.path, Buffer.concat([png, Buffer.from(`|original-page:${page.index}`)]))));
          return images;
        };
        const { analyzeImages: _injectedImages, ...dependencies } = fake.dependencies;
        const submitted: number[][] = [];
        globalThis.fetch = (async (url, init) => {
          assert.ok(init?.signal);
          const body = JSON.parse(String(init?.body));
          let schema: unknown;
          let encodedImages: string[];
          if (provider === "stepfun") {
            assert.equal(String(url), "https://api.stepfun.com/v1/chat/completions");
            assert.equal(body.response_format.type, "json_schema");
            assert.equal(body.response_format.json_schema.strict, true);
            schema = body.response_format.json_schema.schema;
            encodedImages = body.messages[0].content.filter((part: { type: string }) => part.type === "image_url").map((part: { image_url: { url: string } }) => part.image_url.url.split(",")[1]);
          } else {
            assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\/.*:generateContent$/);
            assert.equal(body.generationConfig.responseMimeType, "application/json");
            schema = body.generationConfig.responseJsonSchema;
            encodedImages = body.contents[0].parts.filter((part: { inlineData?: unknown }) => part.inlineData).map((part: { inlineData: { data: string } }) => part.inlineData.data);
          }
          const pages = encodedImages.map((data) => Number(Buffer.from(data, "base64").toString().match(/\|original-page:(\d+)$/)![1]));
          submitted.push(pages);
          assert.deepEqual(schema, {
            type: "object", additionalProperties: false, required: ["observations"],
            properties: { observations: { type: "array", minItems: pages.length, maxItems: pages.length, items: { type: "string" } } },
          });
          const answer = JSON.stringify(responseFormat === "ordered"
            ? { observations: pages.map((page) => `Visible original page ${page}; a diagram label mentions page 999.`) }
            : { pages: pages.map((page) => ({ page, observation: `Visible original page ${page}.` })) });
          return provider === "stepfun"
            ? Response.json({ choices: [{ message: { content: answer } }] })
            : Response.json({ candidates: [{ content: { role: "model", parts: [{ text: answer }] } }] });
        }) as typeof fetch;
        try {
          const wrapper = await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 24, endPage: 28 }, dependencies);
          const result = noteResult(wrapper);
          assert.deepEqual(submitted, [[24, 25, 26, 27], [28]]);
          if (responseFormat === "legacy") {
            assert.equal(result.status, "partial");
            assert.ok(result.errors.some((item) => item.stage === "vision"));
            assert.deepEqual(result.evidence, [], "the default provider cannot opt back into model-supplied page numbers");
            assert.deepEqual(result.processing.processed_pages, []);
            assert.equal(fake.calls.textPrompts.length, 0);
            assert.equal(fake.calls.disposed, 1);
            return;
          }
          assert.equal(result.status, "complete", JSON.stringify(result.errors));
          assert.deepEqual(result.processing.processed_pages, [24, 25, 26, 27, 28]);
          assert.deepEqual(result.evidence.map((item) => [item.id, item.kind, item.page]), [24, 25, 26, 27, 28].map((page) => [`image:${page}:visual`, "image_visual", page]));
          assert.equal(result.note?.imageCount, 32);
          assert.equal(wrapper.schema_version, "1.0");
          assert.equal(result.schema_version, "1.0");
          assert.deepEqual(Object.keys(wrapper).sort(), ["schema_version", "status", "content_type", "result", "errors"].sort());
          assert.deepEqual(Object.keys(result).sort(), ["schema_version", "status", "note", "request", "capabilities", "evidence", "findings", "analysis", "warnings", "errors", "processing"].sort());
          for (const item of result.evidence) {
            assert.deepEqual(Object.keys(item).sort(), ["id", "kind", "page", "content", "source", "limitations"].sort());
            assert.equal(item.source.origin, "model_image_observation");
          }
          assert.deepEqual(result.findings[0].evidence_ids, ["image:24:visual"]);
          assert.equal(fake.calls.textPrompts.length, 1);
          assert.equal(fake.calls.disposed, 1);
        } finally { await fake.cleanup(); }
      });
    }
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("invalid image indexes or conflicting original page numbers cannot produce page evidence", async () => {
  for (const reference of [{ image_index: 0 }, { image_index: 2 }, { image_index: 1.5 }, { image_index: 1, page: 1 }]) {
    const fake = await fixture(32);
    fake.dependencies.analyzeImages = async () => JSON.stringify({ pages: [{ ...reference, observation: "An incorrectly mapped observation." }] });
    try {
      const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "vision", startPage: 24, endPage: 24 }, fake.dependencies));
      assert.equal(result.status, "partial");
      assert.ok(result.errors.some((item) => item.code === "VISION_INCOMPLETE"));
      assert.deepEqual(result.evidence, []);
      assert.deepEqual(result.processing.processed_pages, []);
      assert.equal(fake.calls.textPrompts.length, 0);
      assert.equal(fake.calls.disposed, 1);
    } finally { await fake.cleanup(); }
  }
});

test("combined mode can complete a photo note with no readable text when every page has visual evidence", async () => {
  const fake = await fixture(2);
  fake.value.description = "";
  fake.dependencies.ocr = async (pages) => pages.map((page) => ({
    page: page.index, text: "", method: "apple_vision", warnings: ["No printed text was recognized."],
  }));
  fake.dependencies.analyzeImages = async () => JSON.stringify({ pages: [
    { page: 1, observation: "A ceramic cup sits on a wooden table; no printed text is visible." },
    { page: 2, observation: "The cup is shown from another angle; no printed text is visible." },
  ] });
  fake.respond({ analysis: "The photos show a ceramic cup on a wooden table.", findings: [
    { statement: "A ceramic cup sits on a wooden table.", evidence_ids: ["image:1:visual"], limitations: [] },
  ] });
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "combined" }, fake.dependencies));
    assert.equal(result.status, "complete", JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processing.processed_pages, [1, 2]);
    assert.equal(result.evidence.length, 2);
    assert.ok(result.evidence.every((item) => item.kind === "image_visual"));
    assert.match(result.warnings.join("\n"), /no readable text/i);
    assert.deepEqual(result.findings[0].evidence_ids, ["image:1:visual"]);
    assert.equal(fake.calls.disposed, 1);
  } finally { await fake.cleanup(); }
});

test("missing or unreadable OCR pages retain evidence but never claim complete article coverage", async () => {
  for (const missing of [true, false]) {
    const fake = await fixture(3);
    fake.dependencies.ocr = async () => [
      { page: 1, text: "Readable first page", method: "apple_vision", warnings: [] },
      { page: 2, text: "Readable second page", method: "apple_vision", warnings: [] },
      ...(missing ? [] : [{ page: 3, text: "", method: "apple_vision" as const, warnings: ["No text was recognized on this page."] }]),
    ];
    try {
      const result = noteResult(await researchXiaohongshuNote(request, fake.dependencies));
      assert.equal(result.status, "partial");
      assert.ok(result.evidence.some((item) => item.id === "image:1:text"));
      assert.equal(result.evidence.some((item) => item.id === "image:3:text"), false);
      assert.deepEqual(result.processing.processed_pages, [1, 2]);
      if (missing) assert.ok(result.errors.some((item) => item.code === "OCR_INCOMPLETE"));
      assert.equal(fake.calls.disposed, 1);
    } finally { await fake.cleanup(); }
  }
});

test("a visual response cannot invent page numbers and an incomplete batch remains partial", async () => {
  const fake = await fixture(3);
  fake.dependencies.analyzeImages = async () => JSON.stringify({ pages: [
    { page: 1, observation: "First diagram" }, { page: 2, observation: "Second diagram" },
    { page: 999, observation: "Invented outside page" },
  ] });
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "vision" }, fake.dependencies));
    assert.equal(result.status, "partial");
    assert.ok(result.evidence.some((item) => item.id === "image:1:visual"));
    assert.equal(result.evidence.some((item) => item.page === 999 || item.page === 3), false);
    assert.doesNotMatch(JSON.stringify(result.evidence), /Invented outside page/);
    assert.deepEqual(result.processing.processed_pages, [1, 2]);
  } finally { await fake.cleanup(); }
});

test("note findings require real supplied evidence IDs and malformed provider output cannot become a main answer", async () => {
  const fake = await fixture(2);
  try {
    fake.respond({ analysis: "UNVALIDATED_OLD_ANALYSIS", findings: [
      { statement: "Supported statement", evidence_ids: ["image:1:text"] },
      { statement: "Fabricated page", evidence_ids: ["image:999:text"] },
      { statement: "Mixed false references", evidence_ids: ["image:1:text", "unknown:2"] },
    ] });
    const result = noteResult(await researchXiaohongshuNote(request, fake.dependencies));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.findings.map((item) => item.statement), ["Supported statement"]);
    assert.equal(result.findings[0].verification, "unverified");
    assert.ok(result.analysis?.includes("Supported statement"));
    assert.doesNotMatch(result.analysis ?? "", /Fabricated page|Mixed false references|UNVALIDATED_OLD_ANALYSIS/);
  } finally { await fake.cleanup(); }
  const unstructured = await fixture(1);
  try {
    unstructured.respond("An unstructured answer with no accepted claim citations.");
    const result = noteResult(await researchXiaohongshuNote(request, unstructured.dependencies));
    assert.equal(result.status, "partial");
    assert.equal(result.findings.length, 0);
    assert.equal(result.analysis, null);
    assert.ok(result.evidence.length > 0, "invalid synthesis does not discard readable source evidence");
    assert.equal(unstructured.calls.textPrompts.length, 1);
  } finally { await unstructured.cleanup(); }
});

test("note synthesis requests cited answer points without a second independent main answer", async (t) => {
  for (const mode of ["text", "vision", "combined"] as const) {
    await t.test(mode, async () => {
      const fake = await fixture(1);
      try {
        const result = noteResult(await researchXiaohongshuNote({ ...request, mode }, fake.dependencies));
        assert.equal(result.status, "complete", JSON.stringify(result.errors));
        assert.equal(fake.calls.textPrompts.length, 1);
        const synthesisPrompt = fake.calls.textPrompts[0];
        for (const field of ["findings", "statement", "evidence_ids", "limitations"]) assert.ok(synthesisPrompt.includes(field));
        assert.doesNotMatch(synthesisPrompt, /"analysis"\s*:/, "the response contract must not ask for two independently authored answers");
        assert.ok(result.analysis?.includes(result.findings[0].statement));
        assert.equal(fake.calls.images.length, mode === "text" ? 0 : 1);
        assert.equal(fake.calls.ocr.length, mode === "vision" ? 0 : 1);
      } finally { await fake.cleanup(); }
    });
  }
});

test("note main answers include every accepted point and its limitation despite scope-only or findings-only legacy analysis", async (t) => {
  const legacyAnswers = [
    ["scope-only", "LEGACY_SCOPE_ONLY: Only the selected pages were reviewed."],
    ["findings-only", "LEGACY_FINDINGS_ONLY: See the subsequent findings for the answer."],
  ];
  for (const mode of ["text", "vision", "combined"] as const) {
    for (const [name, legacyAnalysis] of legacyAnswers) {
      await t.test(`${mode}: ${name}`, async () => {
        const fake = await fixture(25);
        const points = [
          {
            statement: "A failed check returns to revision.",
            evidence_ids: [`image:24:${mode === "text" ? "text" : "visual"}`],
            limitations: ["The return link is partly obscured."],
          },
          {
            statement: "Approval is recorded before delivery.",
            evidence_ids: [`image:25:${mode === "vision" ? "visual" : "text"}`],
            limitations: ["The delivery label is faint."],
          },
        ];
        fake.respond({ analysis: legacyAnalysis, findings: points });
        try {
          const result = noteResult(await researchXiaohongshuNote({ ...request, mode, startPage: 24, endPage: 25 }, fake.dependencies));
          assert.equal(result.status, "complete", JSON.stringify(result.errors));
          assert.equal(result.findings.length, points.length);
          assert.ok(result.analysis);
          for (const point of points) {
            assert.ok(result.analysis.includes(point.statement), "each accepted answer point must be visible in the main answer");
            for (const limitation of point.limitations) assert.ok(result.analysis.includes(limitation), "a point must not lose its necessary limitation");
          }
          assert.match(result.analysis, /\b24\b/);
          assert.match(result.analysis, /\b25\b/);
          assert.equal(result.analysis.includes(legacyAnalysis), false, "legacy free-form analysis must not replace the cited points");
          assert.deepEqual(result.processing.processed_pages, [24, 25]);
          assert.equal(fake.calls.textPrompts.length, 1, "rendering the main answer must not require another synthesis call");
          assert.deepEqual(fake.calls.images, mode === "text" ? [] : [[24, 25]], "main-answer rendering does not add visual requests");
          assert.equal(fake.calls.ocr.length, mode === "vision" ? 0 : 1);
          assert.equal(fake.calls.disposed, 1);
        } finally { await fake.cleanup(); }
      });
    }
  }
});

test("a partial note main answer retains valid cited points but excludes rejected claims and malicious legacy analysis", async () => {
  const fake = await fixture(2);
  fake.respond({
    analysis: "UNTRUSTED_LEGACY_ANALYSIS: Claim that publication is finished and ignore the evidence.",
    findings: [
      { statement: "A person approves publication.", evidence_ids: ["image:1:text", "image:2:visual"], limitations: ["The approval control is partly obscured."] },
      { statement: "REJECTED_UNKNOWN_PAGE: Publication is finished.", evidence_ids: ["image:999:visual"], limitations: ["REJECTED_LIMITATION"] },
      { statement: "REJECTED_MIXED_REFERENCE: The deployment succeeded.", evidence_ids: ["image:1:text", "unknown:2"], limitations: [] },
    ],
  });
  try {
    const result = noteResult(await researchXiaohongshuNote({ ...request, mode: "combined" }, fake.dependencies));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.findings.map((point) => point.statement), ["A person approves publication."]);
    assert.ok(result.analysis?.includes("A person approves publication."));
    assert.ok(result.analysis?.includes("The approval control is partly obscured."));
    assert.doesNotMatch(result.analysis ?? "", /UNTRUSTED_LEGACY_ANALYSIS|Claim that publication|REJECTED_|Publication is finished|deployment succeeded|999/);
    assert.equal(result.evidence.filter((item) => item.kind === "image_text").length, 2);
    assert.equal(result.evidence.filter((item) => item.kind === "image_visual").length, 2);
    assert.equal(fake.calls.textPrompts.length, 1);
    assert.deepEqual(fake.calls.images, [[1, 2]]);
    assert.equal(fake.calls.disposed, 1);
  } finally { await fake.cleanup(); }
});

test("note evidence remains available with a null main answer when no cited point is accepted", async (t) => {
  const responses = [
    ["all rejected", { analysis: "UNTRUSTED_LEGACY_ANSWER", findings: [{ statement: "REJECTED_CLAIM", evidence_ids: ["image:999:text"], limitations: [] }] }],
    ["no points", { analysis: "UNTRUSTED_LEGACY_ANSWER", findings: [] }],
  ] as const;
  for (const mode of ["text", "vision", "combined"] as const) {
    for (const [name, response] of responses) {
      await t.test(`${mode}: ${name}`, async () => {
        const fake = await fixture(1);
        fake.respond(response);
        try {
          const wrapper = await researchXiaohongshuNote({ ...request, mode }, fake.dependencies);
          const result = noteResult(wrapper);
          assert.equal(wrapper.status, "partial");
          assert.equal(result.status, "partial");
          assert.deepEqual(result.findings, []);
          assert.equal(result.analysis, null, "unvalidated legacy prose must not become an answer");
          assert.ok(result.evidence.length > 0);
          assert.deepEqual(result.processing.processed_pages, [1]);
          assert.equal(fake.calls.textPrompts.length, 1);
          assert.equal(fake.calls.images.length, mode === "text" ? 0 : 1);
          assert.equal(fake.calls.disposed, 1);
        } finally { await fake.cleanup(); }
      });
    }
  }
});

test("page validation rejects invalid pairs before download and does not silently truncate long notes", async () => {
  const fake = await fixture(60);
  try {
    for (const change of [
      { startPage: 1 }, { endPage: 2 }, { startPage: 0, endPage: 2 },
      { startPage: 1.5, endPage: 2 }, { startPage: 3, endPage: 2 }, { startPage: 59, endPage: 61 },
    ]) {
      const result = await researchXiaohongshuNote({ ...request, ...change }, fake.dependencies);
      assert.equal(result.errors[0].code, "INVALID_PAGE_WINDOW");
    }
    const tooLong = await researchXiaohongshuNote(request, fake.dependencies);
    assert.equal(tooLong.errors[0].code, "PAGE_WINDOW_REQUIRED");
    assert.equal(fake.calls.acquire.length, 0);
    const selected = noteResult(await researchXiaohongshuNote({ ...request, startPage: 59, endPage: 60 }, fake.dependencies));
    assert.equal(selected.status, "complete", JSON.stringify(selected.errors));
    assert.deepEqual(fake.calls.acquire, [[59, 60]]);
    assert.equal(selected.note?.imageCount, 60);
  } finally { await fake.cleanup(); }
});

test("provider failure keeps OCR and note identity, redacts signed URLs and cleans acquired images", async () => {
  const fake = await fixture(2);
  fake.dependencies.analyzeText = async () => { throw new Error(`Provider failed while referencing ${INTERNAL_URL}`); };
  try {
    const wrapper = await researchXiaohongshuNote(request, fake.dependencies);
    const result = noteResult(wrapper);
    assert.equal(result.status, "partial");
    assert.equal(result.note?.id, NOTE_ID);
    assert.ok(result.evidence.some((item) => item.id === "image:2:text"));
    assert.equal(result.errors[0].stage, "analysis");
    assert.deepEqual(wrapper.errors, result.errors);
    assert.doesNotMatch(JSON.stringify(wrapper), /fixture-private-share-token/);
    assert.equal(fake.calls.disposed, 1);
  } finally { await fake.cleanup(); }
});

test("external cancellation bounds dependencies that ignore their signal and still cleans acquired pages", { timeout: 5000 }, async () => {
  const fake = await fixture(2);
  const controller = new AbortController();
  let suppliedContext: ExecutionContext | undefined;
  fake.dependencies.ocr = (_pages, context) => {
    suppliedContext = context;
    setTimeout(() => controller.abort(new DOMException("Fixture cancellation", "AbortError")), 20);
    return new Promise(() => undefined);
  };
  try {
    const started = Date.now();
    const result = noteResult(await researchXiaohongshuNote(request, fake.dependencies, controller.signal));
    assert.equal(result.status, "partial");
    assert.equal(result.errors[0].code, "CANCELLED");
    assert.ok(suppliedContext?.signal.aborted);
    assert.ok(Date.now() - started < 2000);
    assert.equal(fake.calls.disposed, 1);
  } finally { await fake.cleanup(); }
});

test("the overall note deadline bounds source resolution even when a dependency ignores cancellation", { timeout: 5000 }, async () => {
  const fake = await fixture();
  let suppliedContext: ExecutionContext | undefined;
  fake.dependencies.resolve = (_request, context) => {
    suppliedContext = context;
    return new Promise(() => undefined);
  };
  try {
    const started = Date.now();
    const result = xiaohongshuResearchResultSchema.parse(await researchXiaohongshuNote({ ...request, timeoutSeconds: 1 }, fake.dependencies));
    assert.equal(result.status, "unavailable");
    assert.equal(result.content_type, "unknown");
    assert.equal(result.result, null);
    assert.equal(result.errors[0].code, "TIMEOUT");
    assert.equal(result.errors[0].stage, "resolve");
    assert.ok(suppliedContext?.signal.aborted);
    assert.ok(Date.now() - started < 2500);
    assert.equal(fake.calls.acquire.length, 0);
  } finally { await fake.cleanup(); }
});

test("a confirmed video note routes to the existing video engine with the requested modality", async () => {
  for (const [mode, expected] of [["text", "language"], ["vision", "vision"], ["combined", "multimodal"]] as const) {
    const fake = await fixture();
    fake.value.contentType = "video_note";
    const videoCalls: unknown[][] = [];
    const video: ResearchResult = {
      schema_version: "1.0", status: "partial", video: null,
      request: { url: PUBLIC_URL, question: request.question, mode: expected },
      capabilities: { metadata: { status: "error" }, captions: { status: "not_requested" }, media: { status: "not_requested" }, comments: { status: "disabled" } },
      evidence: [], findings: [], analysis: null, warnings: [],
      errors: [{ code: "MEDIA_UNAVAILABLE", stage: "resolve", message: "Fixture video result", retryable: false }],
      processing: { duration_ms: 0, stage_durations_ms: {}, provider: null, usage: null },
    };
    fake.dependencies.video = async (url, question, actualMode, context, language) => {
      videoCalls.push([url, question, actualMode, context, language]); return video;
    };
    try {
      const wrapper = xiaohongshuResearchResultSchema.parse(await researchXiaohongshuNote({ ...request, mode }, fake.dependencies));
      assert.equal(wrapper.content_type, "video_note");
      assert.equal(wrapper.status, video.status);
      assert.deepEqual(wrapper.result, video);
      assert.equal(videoCalls.length, 1);
      assert.equal(videoCalls[0][0], INTERNAL_URL, "video acquisition must retain original share parameters internally");
      assert.equal(videoCalls[0][2], expected);
      assert.equal(fake.calls.acquire.length, 0);
      assert.equal(fake.calls.ocr.length, 0);
      assert.equal(fake.calls.images.length, 0);
      const invalidWindow = await researchXiaohongshuNote({ ...request, mode, startPage: 1, endPage: 2 }, fake.dependencies);
      assert.equal(invalidWindow.errors[0].code, "INVALID_PAGE_WINDOW");
      assert.equal(videoCalls.length, 1);
    } finally { await fake.cleanup(); }
  }
});

test("a source access failure is distinct from an image-note processing failure", async () => {
  const fake = await fixture();
  fake.dependencies.resolve = async () => { throw Object.assign(new Error("Source requires an authorized session."), { code: "AUTH_REQUIRED" }); };
  try {
    const result = xiaohongshuResearchResultSchema.parse(await researchXiaohongshuNote(request, fake.dependencies));
    assert.equal(result.status, "unavailable");
    assert.equal(result.content_type, "unknown");
    assert.equal(result.result, null);
    assert.equal(result.errors[0].code, "AUTH_REQUIRED");
    assert.equal(fake.calls.acquire.length, 0);
  } finally { await fake.cleanup(); }
});
