import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcquisitionError } from "../src/acquisition.js";
import { getAdapter, parseSourceUrl } from "../src/adapters/index.js";
import type { ExecutionContext, ResearchRequest } from "../src/contracts.js";
import { XiaohongshuAdapter, resolveXiaohongshuUrl, xiaohongshuDuration } from "../src/adapters/xiaohongshu.js";

const NOTE_ID = "674051740000000007027a15";
const NOTE_URL = `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?xsec_token=fixture-share-token&xsec_source=app_share`;
const request: ResearchRequest = { url: NOTE_URL, question: "What does the demonstration show?", mode: "language", language: "zh" };

function context(ms = 5000): ExecutionContext {
  return { signal: AbortSignal.timeout(ms), deadlineMs: Date.now() + ms };
}

function code(expected: string) {
  return (error: unknown): boolean => error instanceof AcquisitionError && error.code === expected;
}

async function withEnv<T>(settings: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function videoMetadata(): Record<string, unknown> {
  return {
    id: NOTE_ID, title: "A public demonstration", description: "Fixture public description", uploader_id: "fixture-author",
    tags: ["tutorial"],
    formats: [
      { format_id: "h264", vcodec: "h264", acodec: "aac", width: 720, height: 1280, fps: 30, duration: 28.073, url: "https://cdn.invalid/video?token=private-media-token" },
      { format_id: "hevc", vcodec: "hevc", acodec: "aac", duration: 28.073 },
    ],
    url: "https://cdn.invalid/video?token=private-media-token",
    http_headers: { Cookie: "fixture-private-cookie" },
    xsec_token: "fixture-private-extractor-token",
  };
}

async function fakeDownloader(data: Record<string, unknown> = videoMetadata()) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-xhs-test-"));
  const script = path.join(directory, "downloader.cjs");
  const config = path.join(directory, "metadata.json");
  const log = path.join(directory, "args.json");
  await fs.writeFile(config, JSON.stringify(data));
  await fs.writeFile(script, `const fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(args));console.log(fs.readFileSync(${JSON.stringify(config)},'utf8'));`);
  return {
    directory, script, config, log,
    update: (value: Record<string, unknown>) => fs.writeFile(config, JSON.stringify(value)),
    run: <T>(action: () => Promise<T>) => withEnv({
      YTDLP_PATH: script, YTDLP_PYTHON: process.execPath,
      XIAOHONGSHU_COOKIES_FILE: undefined, XIAOHONGSHU_COOKIES_FROM_BROWSER: undefined,
    }, action),
  };
}

test("Xiaohongshu note links preserve acquisition parameters and reject unsafe URL forms", async () => {
  const adapter = new XiaohongshuAdapter();
  for (const input of [NOTE_URL, `https://xiaohongshu.com/explore/${NOTE_ID}?xsec_token=fixture-share-token`]) {
    assert.equal(adapter.supports(new URL(input)), true);
    const result = await resolveXiaohongshuUrl(input, context());
    assert.equal(result.id, NOTE_ID);
    const canonical = new URL(result.canonicalUrl);
    assert.equal(canonical.protocol, "https:");
    assert.equal(canonical.hostname, "www.xiaohongshu.com");
    assert.equal(canonical.searchParams.get("xsec_token"), "fixture-share-token");
    assert.match(canonical.pathname, new RegExp(`${NOTE_ID}/?$`));
  }
  for (const input of [
    `http://www.xiaohongshu.com/explore/${NOTE_ID}`,
    `https://www.xiaohongshu.com.evil.invalid/explore/${NOTE_ID}`,
    `https://user:password@www.xiaohongshu.com/explore/${NOTE_ID}`,
    `https://www.xiaohongshu.com:8443/explore/${NOTE_ID}`,
    "file:///tmp/video", "https://www.xiaohongshu.com/user/profile/fixture",
    "https://www.xiaohongshu.com/explore/not-a-note-id",
  ]) {
    await assert.rejects(() => resolveXiaohongshuUrl(input, context()), code("INVALID_URL"));
  }
});

test("official Xiaohongshu share domains resolve with guarded redirects and retain the full share query", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal);
      return new Response(null, { status: 302, headers: { location: NOTE_URL } });
    }) as typeof fetch;
    for (const short of ["https://xhslink.com/a/fixture", "https://xhslink.cn/o/fixture", "https://www.xhslink.com/a/fixture", "https://www.xhslink.cn/o/fixture"]) {
      const resolved = await resolveXiaohongshuUrl(short, context());
      assert.equal(resolved.id, NOTE_ID);
      const canonical = new URL(resolved.canonicalUrl);
      assert.equal(canonical.searchParams.get("xsec_token"), "fixture-share-token");
      assert.equal(canonical.searchParams.get("xsec_source"), "app_share");
    }
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = original; }
});

test("copied Xiaohongshu share text routes one URL and upgrades insecure short links before fetching", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: NOTE_URL } });
    }) as typeof fetch;
    for (const input of [
      "http://xhslink.cn/o/fixture",
      "51 分享了一篇视频笔记 http://xhslink.com/a/fixture，复制本条信息，打开小红书查看！",
      "https://xhslink.cn/o/fixture，复制本条信息，打开小红书查看！",
      `分享给你（${NOTE_URL}），看看这个视频`,
    ]) {
      assert.equal(getAdapter(input).platform, "xiaohongshu");
      assert.equal((await resolveXiaohongshuUrl(input, context())).id, NOTE_ID);
    }
    assert.deepEqual(calls, ["https://xhslink.cn/o/fixture", "https://xhslink.com/a/fixture", "https://xhslink.cn/o/fixture"]);
    for (const input of [
      `视频 ${NOTE_URL} 另一个 https://xhslink.cn/o/other`,
      `https://xhslink.cn/o/one https://xhslink.cn/o/two`,
      "https://xhslink.cn/o/one，另一个：https://xhslink.cn/o/two",
      "视频 https://evil.invalid/note", "没有链接的分享文案",
    ]) assert.throws(() => parseSourceUrl(input), code("INVALID_URL"));
  } finally { globalThis.fetch = original; }
});

test("Xiaohongshu share failures distinguish platform access states from invalid user input", async () => {
  const original = globalThis.fetch;
  let reply: () => Response = () => new Response(null, { status: 401 });
  try {
    globalThis.fetch = (async () => reply()) as typeof fetch;
    for (const [status, expected] of [[401, "AUTH_REQUIRED"], [403, "ACCESS_BLOCKED"], [412, "ACCESS_BLOCKED"], [404, "CONTENT_UNAVAILABLE"], [410, "CONTENT_UNAVAILABLE"]] as const) {
      reply = () => new Response(null, { status });
      await assert.rejects(() => resolveXiaohongshuUrl("https://xhslink.cn/o/fixture", context()), code(expected));
    }
    for (const [destination, expected] of [["/login?redirectPath=private", "AUTH_REQUIRED"], ["/404/sec_fixture?error_code=300031", "CONTENT_UNAVAILABLE"]] as const) {
      reply = () => new Response(null, { status: 302, headers: { location: `https://www.xiaohongshu.com${destination}` } });
      await assert.rejects(() => resolveXiaohongshuUrl("https://xhslink.cn/o/fixture", context()), code(expected));
    }
    reply = () => new Response(null, { status: 429 });
    await assert.rejects(() => resolveXiaohongshuUrl("https://xhslink.cn/o/fixture", context()), (error: unknown) => {
      assert.ok(error instanceof AcquisitionError);
      assert.equal(error.retryable, true);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test("Xiaohongshu short links cannot redirect outside approved HTTPS hosts or loop indefinitely", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let destination = `https://www.xiaohongshu.com.evil.invalid/explore/${NOTE_ID}`;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: destination } });
    }) as typeof fetch;
    await assert.rejects(() => resolveXiaohongshuUrl("https://xhslink.com/a/fixture", context()), code("INVALID_URL"));
    assert.equal(calls, 1, "the external redirect target must never be fetched");
    for (const unsafe of [
      `http://www.xiaohongshu.com/explore/${NOTE_ID}`,
      `https://user:password@www.xiaohongshu.com/explore/${NOTE_ID}`,
      `https://www.xiaohongshu.com:8443/explore/${NOTE_ID}`,
    ]) {
      destination = unsafe;
      calls = 0;
      await assert.rejects(() => resolveXiaohongshuUrl("https://xhslink.com/a/fixture", context()), code("INVALID_URL"));
      assert.equal(calls, 1, "the unsafe redirect target must never be fetched");
    }
    destination = "https://xhslink.cn/o/loop";
    calls = 0;
    await assert.rejects(() => resolveXiaohongshuUrl(destination, context()), code("RESOLUTION_FAILED"));
    assert.ok(calls <= 5, "a redirect loop must have a fixed bound");
  } finally { globalThis.fetch = original; }
});

test("cancelled Xiaohongshu short-link resolution stops before fetching", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  controller.abort(new DOMException("Fixture cancellation", "AbortError"));
  let calls = 0;
  try {
    globalThis.fetch = (async () => { calls += 1; throw new Error("Must not fetch"); }) as typeof fetch;
    await assert.rejects(() => resolveXiaohongshuUrl("https://xhslink.com/a/fixture", { signal: controller.signal, deadlineMs: Date.now() + 1000 }));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("Xiaohongshu duration uses reported metadata or consistent stream durations without inventing a value", () => {
  assert.deepEqual(xiaohongshuDuration({ duration: 12.5, formats: [{ duration: 28.073 }] }), { seconds: 12.5, origin: "metadata" });
  assert.deepEqual(xiaohongshuDuration({ formats: [{ duration: 28.073 }, { duration: 28.073 }, {}] }), { seconds: 28.073, origin: "format_metadata" });
  assert.deepEqual(xiaohongshuDuration({ formats: [{ duration: 28 }, { duration: 28.2 }] }), { seconds: 28.2, origin: "format_metadata" });
  for (const data of [{}, { duration: 0 }, { duration: -1 }, { duration: true }, { duration: Infinity }, { formats: [{ duration: 20 }, { duration: 40 }] }]) {
    assert.throws(() => xiaohongshuDuration(data), code("INVALID_METADATA"));
  }
});

test("Xiaohongshu metadata acquisition uses isolated credentials and exposes honest capability states", async () => {
  const fake = await fakeDownloader();
  const cookies = Object.fromEntries(["xhs", "bili", "youtube"].map((name) => [name, path.join(fake.directory, `${name}.cookies.txt`)]));
  await Promise.all(Object.values(cookies).map((filename) => fs.writeFile(filename, "test fixture only; not a real credential")));
  try {
    await fake.run(async () => withEnv({
      XIAOHONGSHU_COOKIES_FILE: cookies.xhs,
      BILIBILI_COOKIES_FILE: cookies.bili,
      YOUTUBE_COOKIES_FILE: cookies.youtube,
    }, async () => {
      const result = await new XiaohongshuAdapter().resolve({ ...request, includeComments: true }, context());
      assert.equal(result.video.id, NOTE_ID);
      assert.equal(result.video.durationSeconds, 28.073);
      assert.equal(new URL(result.video.canonicalUrl).searchParams.get("xsec_token"), "fixture-share-token");
      assert.equal(result.captions.status, "unsupported");
      assert.equal(result.captions.kind, "unknown");
      assert.deepEqual(result.captions.cues, []);
      assert.equal(result.comments.status, "unsupported");
      assert.deepEqual(result.comments.items, []);
      assert.equal(result.capabilities.metadata.status, "available");
      assert.equal(result.capabilities.captions.status, "unsupported");
      const publicMetadata = JSON.stringify(result.video.metadata);
      assert.doesNotMatch(publicMetadata, /private-media-token|private-cookie|private-extractor-token|cdn\.invalid|xsec_token/);
      const args = JSON.parse(await fs.readFile(fake.log, "utf8")) as string[];
      assert.ok(args.includes("--ignore-config"));
      assert.ok(args.includes(cookies.xhs));
      assert.ok(!args.includes(cookies.bili));
      assert.ok(!args.includes(cookies.youtube));
      assert.ok(!args.includes("--js-runtimes"));
      const source = new URL(args.at(-1)!);
      assert.equal(source.searchParams.get("xsec_token"), "fixture-share-token");
    }));
  } finally { await fs.rm(fake.directory, { recursive: true, force: true }); }
});

test("Xiaohongshu visual and multimodal resolution does not claim captions or request disabled comments", async () => {
  const fake = await fakeDownloader();
  try {
    await fake.run(async () => {
      for (const mode of ["vision", "multimodal"] as const) {
        const result = await new XiaohongshuAdapter().resolve({ ...request, mode }, context());
        assert.equal(result.captions.status, "not_requested");
        assert.deepEqual(result.captions.cues, []);
        assert.equal(result.comments.status, "disabled");
        assert.deepEqual(result.comments.items, []);
      }
    });
  } finally { await fs.rm(fake.directory, { recursive: true, force: true }); }
});

test("Xiaohongshu rejects explicit non-video content without guessing why an empty format list occurred", async () => {
  const fake = await fakeDownloader();
  try {
    await fake.run(async () => {
      for (const content of [{ note_type: "normal" }, { type: "image" }, { _type: "playlist" }, { is_live: true }]) {
        await fake.update({ ...videoMetadata(), ...content });
        await assert.rejects(() => new XiaohongshuAdapter().resolve(request, context()), code("UNSUPPORTED_CONTENT"));
      }
      await fake.update({ ...videoMetadata(), duration: 28.073, formats: [] });
      await assert.rejects(() => new XiaohongshuAdapter().resolve(request, context()), code("MEDIA_UNAVAILABLE"));
      for (const format of [
        { ext: "jpg", width: 1080, height: 1920, url: "https://cdn.invalid/image.jpg" },
        { ext: "m4a", vcodec: "none", url: "https://cdn.invalid/audio.m4a" },
        { url: "https://cdn.invalid/unknown" },
      ]) {
        await fake.update({ ...videoMetadata(), duration: 28.073, formats: [format] });
        await assert.rejects(() => new XiaohongshuAdapter().resolve(request, context()), code("MEDIA_UNAVAILABLE"));
      }
    });
  } finally { await fs.rm(fake.directory, { recursive: true, force: true }); }
});

test("Xiaohongshu rejects mismatched identities and unknown media durations", async () => {
  const fake = await fakeDownloader();
  try {
    await fake.run(async () => {
      await fake.update({ ...videoMetadata(), id: "6411cf99000000001300b6d9" });
      await assert.rejects(() => new XiaohongshuAdapter().resolve(request, context()), code("INVALID_METADATA"));
      await fake.update({ ...videoMetadata(), id: undefined });
      await assert.rejects(() => new XiaohongshuAdapter().resolve(request, context()), code("INVALID_METADATA"));
      await fake.update({ ...videoMetadata(), formats: [{ format_id: "direct", ext: "mp4", vcodec: "h264" }] });
      await assert.rejects(() => new XiaohongshuAdapter().resolve(request, context()), code("INVALID_METADATA"));
    });
  } finally { await fs.rm(fake.directory, { recursive: true, force: true }); }
});
