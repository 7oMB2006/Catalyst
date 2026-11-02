import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { AcquisitionError } from "../src/acquisition.js";
import { acquireNoteImages } from "../src/adapters/xiaohongshu-note.js";
import type { ExecutionContext } from "../src/contracts.js";
import { extractImageText } from "../src/image-analysis.js";
import type { XiaohongshuNoteSource } from "../src/note-contracts.js";
import { analyzeImagesWithProvider } from "../src/video-analysis.js";

// Generated once with FFmpeg/libaom-av1 from an 8x6 solid-color test pattern.
// CI needs an AVIF decoder, not an AV1 encoder or any external image source.
const AVIF = Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAXAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAIAAAABgAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAfbWRhdAoFGAi9aAIyDhgAAABQAAAAsBOom2Pa", "base64");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const NOTE_ID = "6ae80a83000000001a0153d3";

function context(ms = 15_000): ExecutionContext {
  return { signal: AbortSignal.timeout(ms), deadlineMs: Date.now() + ms };
}
function source(): XiaohongshuNoteSource {
  return {
    id: NOTE_ID, sourceUrl: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
    canonicalUrl: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
    title: "AVIF fixture note", description: "", contentType: "image_note",
    pages: [{ index: 24, url: "https://sns-webpic-qc.xhscdn.com/fixture/image?sign=fixture-private-token", width: 8, height: 6 }],
  };
}

async function withEnv<T>(settings: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(settings)) value === undefined ? delete process.env[key] : process.env[key] = value;
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

// Record this worker's actual acquisition directory rather than comparing all
// shared temp directories, which other test workers may create concurrently.
async function trackImageDirectories(action: (directories: string[]) => Promise<void>): Promise<void> {
  const original = fs.mkdtemp;
  const directories: string[] = [];
  fs.mkdtemp = ((...args: unknown[]) => (Reflect.apply(original, fs, args) as Promise<string | Buffer>).then((directory) => {
    if (String(args[0]).includes("catalyst-note-images-")) directories.push(String(directory));
    return directory;
  })) as typeof fs.mkdtemp;
  try { await action(directories); }
  finally {
    fs.mkdtemp = original;
    await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
  }
}

test("acquired AVIF pages become real PNG inputs for vision and the Windows/Linux provider OCR path", { timeout: 30_000 }, async () => {
  const oldFetch = globalThis.fetch;
  let downloadCalls = 0, providerCalls = 0;
  try {
    await withEnv({
      FFMPEG_PATH: undefined, CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_API_KEY: "fixture-stepfun-key",
      STEPFUN_BASE_URL: "https://api.stepfun.com/step_plan/v1", CATALYST_OCR_ENGINE: "auto",
    }, async () => {
      globalThis.fetch = (async (input, init) => {
        if (new URL(String(input)).hostname.endsWith(".xhscdn.com")) {
          downloadCalls++;
          const accept = new Headers(init?.headers).get("Accept") ?? "";
          assert.match(accept, /image\/(?:png|jpeg)/);
          assert.doesNotMatch(accept, /image\/avif/);
          // A CDN may ignore negotiation; the actual response still needs to work.
          return new Response(AVIF, { headers: { "content-type": "image/avif" } });
        }
        providerCalls++;
        assert.equal(String(input), "https://api.stepfun.com/step_plan/v1/chat/completions");
        assert.ok(init?.signal);
        const body = JSON.parse(String(init?.body));
        const content = body.messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
        const image = content.find((item) => item.type === "image_url")?.image_url?.url;
        assert.ok(image);
        assert.ok(image.startsWith("data:image/png;base64,"));
        const bytes = Buffer.from(image.split(",")[1], "base64");
        assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE));
        assert.equal(bytes.readUInt32BE(16), 8);
        assert.equal(bytes.readUInt32BE(20), 6);
        assert.doesNotMatch(String(init?.body), /fixture-private-token|xhscdn|\.avif/);
        const prompt = content.find((item) => item.type === "text")?.text ?? "";
        return Response.json({ choices: [{ message: { content: prompt.includes("Transcribe readable text")
          ? JSON.stringify({ pages: [{ page: 24, text: "Fixture text on source page 24." }] })
          : "The image shows a solid-color fixture." } }] });
      }) as typeof fetch;
      const acquired = await acquireNoteImages(source(), [24], context());
      try {
        assert.equal(acquired.bytes, AVIF.length, "download bytes must not become converted PNG bytes");
        assert.deepEqual(acquired.pages.map((page) => page.index), [24]);
        assert.equal(path.extname(acquired.pages[0].path), ".png");
        assert.ok((await fs.readFile(acquired.pages[0].path)).subarray(0, 8).equals(PNG_SIGNATURE));
        assert.ok((await fs.readdir(acquired.directory)).every((name) => !name.endsWith(".avif")), "the original conversion input is removed");
        assert.equal(await analyzeImagesWithProvider([acquired.pages[0].path], "Describe this image", { context: context() }), "The image shows a solid-color fixture.");
        const text = await extractImageText(acquired.pages, context(), "zh", { platform: "linux", cache: false });
        assert.deepEqual(text.map((page) => [page.page, page.method, page.text]), [[24, "provider_ocr", "Fixture text on source page 24."]]);
        assert.equal(downloadCalls, 1);
        assert.equal(providerCalls, 2);
      } finally { await acquired.dispose(); }
      assert.equal(await fs.access(acquired.directory).then(() => true, () => false), false);
    });
  } finally { globalThis.fetch = oldFetch; }
});

test("a corrupt AVIF decode fails safely and removes its input and partial conversion files", { timeout: 30_000 }, async () => {
  const oldFetch = globalThis.fetch;
  try {
    await withEnv({ FFMPEG_PATH: undefined }, async () => {
      globalThis.fetch = (async () => new Response(AVIF.subarray(0, 32), { headers: { "content-type": "image/avif" } })) as typeof fetch;
      await trackImageDirectories(async (directories) => {
        await assert.rejects(() => acquireNoteImages(source(), [24], context()), (error: unknown) => {
          assert.ok(error instanceof AcquisitionError);
          assert.equal(error.code, "IMAGE_CONVERSION_FAILED");
          assert.doesNotMatch(error.message, /fixture-private-token|xhscdn/);
          return true;
        });
        assert.equal(directories.length, 1);
        assert.equal(await fs.access(directories[0]).then(() => true, () => false), false);
      });
    });
  } finally { globalThis.fetch = oldFetch; }
});

test("cancelled or expired AVIF acquisition stops before fetching or creating conversion files", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new DOMException("Fixture cancellation", "AbortError"));
  try {
    globalThis.fetch = (async () => { calls++; throw new Error("Must not fetch"); }) as typeof fetch;
    await trackImageDirectories(async (directories) => {
      await assert.rejects(() => acquireNoteImages(source(), [24], { signal: controller.signal, deadlineMs: Date.now() + 1000 }));
      await assert.rejects(() => acquireNoteImages(source(), [24], { signal: new AbortController().signal, deadlineMs: Date.now() - 1 }), (error: unknown) => error instanceof AcquisitionError && error.code === "TIMEOUT");
      assert.equal(calls, 0);
      assert.deepEqual(directories, []);
    });
  } finally { globalThis.fetch = oldFetch; }
});
