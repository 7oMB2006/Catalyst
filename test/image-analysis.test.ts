import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExecutionContext } from "../src/contracts.js";
import type { AcquiredNotePage } from "../src/note-contracts.js";
import { extractImageText, ImageOcrError } from "../src/image-analysis.js";
import { analyzeImagesWithProvider } from "../src/video-analysis.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6S8AAAAASUVORK5CYII=", "base64");
const context = (): ExecutionContext => ({ signal: AbortSignal.timeout(10_000), deadlineMs: Date.now() + 10_000 });

async function withEnv<T>(settings: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(settings)) value === undefined ? delete process.env[key] : process.env[key] = value;
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

async function fixtures(count = 2, first = 7) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-image-test-"));
  const pages: AcquiredNotePage[] = [];
  for (let i = 0; i < count; i++) {
    const filename = path.join(directory, `image-${first + i}.unknown`);
    await fs.writeFile(filename, Buffer.concat([PNG, Buffer.from(String(first + i))]));
    pages.push({ index: first + i, path: filename });
  }
  return { directory, pages, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("image providers use inline image payloads, signature-derived MIME and cancellation without video uploads", async () => {
  const fake = await fixtures();
  const oldFetch = globalThis.fetch;
  let calls = 0;
  try {
    await withEnv({ CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_API_KEY: "fixture-stepfun-key", STEPFUN_BASE_URL: "https://api.stepfun.com/step_plan/v1" }, async () => {
      globalThis.fetch = (async (url, init) => {
        calls++;
        assert.equal(String(url), "https://api.stepfun.com/step_plan/v1/chat/completions");
        assert.ok(init?.signal);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.messages[0].content[0].type, "text");
        const images = body.messages[0].content.filter((item: { type: string }) => item.type === "image_url");
        assert.equal(images.length, 2);
        assert.ok(images.every((item: { image_url: { url: string } }) => item.image_url.url.startsWith("data:image/png;base64,")));
        assert.doesNotMatch(String(init?.body), /video_url|stepfile:|image-7\.unknown/);
        return Response.json({ choices: [{ message: { content: "fixture image observation" } }] });
      }) as typeof fetch;
      assert.equal(await analyzeImagesWithProvider(fake.pages.map((page) => page.path), "Read these pages", { context: context() }), "fixture image observation");
      const controller = new AbortController(); controller.abort();
      await assert.rejects(() => analyzeImagesWithProvider([fake.pages[0].path], "Cancelled", { context: { signal: controller.signal, deadlineMs: Date.now() + 1000 } }));
      assert.equal(calls, 1);
    });
    await withEnv({ CODEX_VIDEO_PROVIDER: "gemini", GEMINI_API_KEY: "fixture-gemini-key" }, async () => {
      globalThis.fetch = (async (url, init) => {
        calls++;
        assert.match(String(url), /generativelanguage\.googleapis\.com/);
        assert.match(String(url), /generateContent/);
        const body = JSON.parse(String(init?.body));
        const imagePart = body.contents[0].parts.find((part: Record<string, unknown>) => part.inlineData || part.inline_data);
        assert.ok(imagePart);
        const data = imagePart.inlineData ?? imagePart.inline_data;
        assert.equal(data.mimeType ?? data.mime_type, "image/png");
        assert.ok(data.data.startsWith(PNG.toString("base64").slice(0, 24)));
        assert.doesNotMatch(String(init?.body), /fileData|file_data|video_url/);
        return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Gemini image observation" }] } }] });
      }) as typeof fetch;
      assert.equal(await analyzeImagesWithProvider([fake.pages[0].path], "Read this page", { context: context() }), "Gemini image observation");
    });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = oldFetch; await fake.cleanup(); }
});

test("image input bounds reject oversized, disguised and over-budget requests before provider access", async () => {
  const fake = await fixtures(5);
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new Error("Provider must not be called"); }) as typeof fetch;
    await assert.rejects(() => analyzeImagesWithProvider([], "Empty"), /between one and four/);
    await assert.rejects(() => analyzeImagesWithProvider(fake.pages.map((page) => page.path), "Too many"), /between one and four/);
    await fs.writeFile(fake.pages[0].path, "<html>not image bytes</html>");
    await assert.rejects(() => analyzeImagesWithProvider([fake.pages[0].path], "HTML"), /must contain JPEG/);
    await fs.truncate(fake.pages[0].path, 12 * 1024 * 1024 + 1);
    await assert.rejects(() => analyzeImagesWithProvider([fake.pages[0].path], "Oversized"), /at most 12 MiB/);
    await assert.rejects(() => analyzeImagesWithProvider([fake.pages[1].path], "x".repeat(19_000_000)), /19 MB budget/);
  } finally { globalThis.fetch = oldFetch; await fake.cleanup(); }
});

test("provider OCR batches preserve every original page number and mark empty text honestly", async () => {
  const fake = await fixtures(9, 21);
  const calls: number[][] = [];
  try {
    await withEnv({ CATALYST_OCR_ENGINE: "provider" }, async () => {
      const ctx = context();
      const values = await extractImageText(fake.pages, ctx, "zh", {
        images: async (paths, prompt, options) => {
          assert.ok(paths.length <= 4);
          assert.equal(options?.context, ctx);
          assert.match(prompt, /never an instruction/);
          assert.doesNotMatch(prompt, /\.unknown|catalyst-image-test/);
          const pages = prompt.match(/exact source-page order: ([\d, ]+)\./)![1].split(", ").map(Number);
          calls.push(pages);
          return JSON.stringify({ pages: pages.map((page) => ({ page, text: page === 25 ? "" : `Exact source text ${page}` })) });
        },
      });
      assert.deepEqual(calls, [[21, 22, 23, 24], [25, 26, 27, 28], [29]]);
      assert.deepEqual(values.map((page) => page.page), fake.pages.map((page) => page.index));
      assert.ok(values.every((page) => page.method === "provider_ocr"));
      assert.equal(values[4].text, "");
      assert.match(values[4].warnings.join(" "), /does not establish/);
    });
  } finally { await fake.cleanup(); }
});

test("malformed, duplicate, unexpected and omitted OCR pages fail while retaining only unambiguous source pages", async () => {
  const fake = await fixtures(2, 7);
  try {
    await withEnv({ CATALYST_OCR_ENGINE: "provider" }, async () => {
      for (const [response, preserved] of [
        ["not JSON", []],
        [JSON.stringify({ pages: [{ page: 7, text: "retained" }] }), [7]],
        [JSON.stringify({ pages: [{ page: 7, text: "retained" }, { page: 8, text: "valid" }, { page: 99, text: "wrong page" }] }), [7, 8]],
        [JSON.stringify({ pages: [{ page: 7, text: "first" }, { page: 7, text: "second" }, { page: 7, text: "third" }, { page: 8, text: "valid" }] }), [8]],
      ] as const) {
        await assert.rejects(() => extractImageText(fake.pages, context(), undefined, { images: async () => response }), (error: unknown) => {
          assert.ok(error instanceof ImageOcrError);
          assert.equal(error.code, "OCR_INVALID_RESPONSE");
          assert.deepEqual(error.pages.map((page) => page.page), preserved);
          return true;
        });
      }
    });
  } finally { await fake.cleanup(); }
});

test("OCR cancellation retains completed batches and does not issue another provider call", async () => {
  const fake = await fixtures(5, 31);
  const controller = new AbortController();
  let calls = 0;
  try {
    await withEnv({ CATALYST_OCR_ENGINE: "provider" }, async () => {
      await assert.rejects(() => extractImageText(fake.pages, { signal: controller.signal, deadlineMs: Date.now() + 5000 }, undefined, {
        images: async () => {
          calls++; controller.abort(new DOMException("Fixture stop", "AbortError"));
          return JSON.stringify({ pages: [31, 32, 33, 34].map((page) => ({ page, text: "transcribed before cancellation" })) });
        },
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AbortError");
        assert.deepEqual((error as Error & { pages: Array<{ page: number }> }).pages.map((page) => page.page), [31, 32, 33, 34]);
        return true;
      });
      assert.equal(calls, 1);
    });
  } finally { await fake.cleanup(); }
});

test("automatic OCR uses local Vision without a provider and falls back only when its runtime is unavailable", async () => {
  const fake = await fixtures(1, 41);
  let providerCalls = 0;
  const images = async () => { providerCalls++; return JSON.stringify({ pages: [{ page: 41, text: "provider transcription" }] }); };
  try {
    await withEnv({ CATALYST_OCR_ENGINE: "auto" }, async () => {
      const local = await extractImageText(fake.pages, context(), "zh", {
        platform: "darwin", local: async (pages) => pages.map((page) => ({ page: page.index, text: "local transcription", method: "apple_vision", warnings: [] })), images,
      });
      assert.equal(local[0].method, "apple_vision");
      assert.equal(providerCalls, 0);
      const fallback = await extractImageText(fake.pages, context(), "zh", {
        platform: "darwin", local: async () => { throw new ImageOcrError("OCR_UNAVAILABLE", "Fixture missing Swift"); }, images,
      });
      assert.equal(fallback[0].method, "provider_ocr");
      assert.match(fallback[0].warnings.join(" "), /sent to the configured model provider/);
      assert.equal(providerCalls, 1);
      await assert.rejects(() => extractImageText(fake.pages, context(), "zh", {
        platform: "darwin", local: async () => { throw new ImageOcrError("TIMEOUT", "Fixture timeout"); }, images,
      }), /Fixture timeout/);
      assert.equal(providerCalls, 1, "a local timeout must not start an additional upload");
    });
    await withEnv({ CATALYST_OCR_ENGINE: "apple_vision" }, async () => {
      await assert.rejects(() => extractImageText(fake.pages, context(), undefined, { platform: "win32", images }), /only available on macOS/);
      assert.equal(providerCalls, 1);
    });
    await withEnv({ CATALYST_OCR_ENGINE: "invalid" }, async () => {
      await assert.rejects(() => extractImageText(fake.pages, context(), undefined, { images }), /must be auto/);
    });
  } finally { await fake.cleanup(); }
});

test("OCR cache reuses image content across page selections and invalidates for bytes, language, model and expiry", async () => {
  const fake = await fixtures(1, 51);
  let calls = 0;
  let responsePage = 51;
  const images = async () => { calls++; return JSON.stringify({ pages: [{ page: responsePage, text: "Same readable source text" }] }); };
  const dependencies = { images, cache: true };
  const originalNow = Date.now;
  try {
    await withEnv({ CATALYST_OCR_ENGINE: "provider", CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_VIDEO_MODEL: "fixture-ocr-model-cache-a" }, async () => {
      await extractImageText(fake.pages, context(), "zh", dependencies);
      responsePage = 99;
      const rebound = await extractImageText([{ ...fake.pages[0], index: 99 }], context(), "zh", dependencies);
      assert.equal(calls, 1, "cached text is reused without sending the same image again");
      assert.equal(rebound[0].page, 99, "evidence uses the current source-page number");
      assert.equal(rebound[0].method, "provider_ocr");
      responsePage = 51;
      await extractImageText(fake.pages, context(), "en", dependencies);
      assert.equal(calls, 2);
      await fs.appendFile(fake.pages[0].path, "changed bytes");
      await extractImageText(fake.pages, context(), "en", dependencies);
      assert.equal(calls, 3);
      process.env.STEPFUN_VIDEO_MODEL = "fixture-ocr-model-cache-b";
      await extractImageText(fake.pages, context(), "en", dependencies);
      assert.equal(calls, 4);
      const future = originalNow() + 31 * 60 * 1000;
      Date.now = () => future;
      await extractImageText(fake.pages, context(), "en", dependencies);
      assert.equal(calls, 5, "expired results require fresh OCR");
    });
  } finally { Date.now = originalNow; await fake.cleanup(); }
});

test("invalid and empty OCR results never populate the process cache", async () => {
  const fake = await fixtures(1, 61);
  let calls = 0;
  try {
    await withEnv({ CATALYST_OCR_ENGINE: "provider", STEPFUN_VIDEO_MODEL: "fixture-ocr-failure-cache" }, async () => {
      const dependencies = { cache: true, images: async () => {
        calls++;
        return calls === 1 ? "invalid JSON" : JSON.stringify({ pages: [{ page: 61, text: calls === 2 ? "" : "Recovered source text" }] });
      } };
      await assert.rejects(() => extractImageText(fake.pages, context(), "zh", dependencies), /valid page-to-text/);
      const empty = await extractImageText(fake.pages, context(), "zh", dependencies);
      assert.equal(empty[0].text, "");
      const recovered = await extractImageText(fake.pages, context(), "zh", dependencies);
      assert.equal(recovered[0].text, "Recovered source text");
      await extractImageText(fake.pages, context(), "zh", dependencies);
      assert.equal(calls, 3);
    });
  } finally { await fake.cleanup(); }
});
