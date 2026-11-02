import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExecutionContext, ResearchRequest, VideoIdentity } from "../src/contracts.js";
import { acquireMediaWindow, prepareResearchWindow } from "../src/media-window.js";
import { runProcess } from "../src/process.js";
import { getFfmpegPath } from "../src/video-analysis.js";

function context(ms = 30_000): ExecutionContext { return { signal: AbortSignal.timeout(ms), deadlineMs: Date.now() + ms }; }
const video: VideoIdentity = { platform: "bilibili", id: "BV1DTxXzUEvW", partId: "38253823575", sourceUrl: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17", canonicalUrl: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17", title: "Part 17 fixture", durationSeconds: 4276 };
const request: ResearchRequest = { url: video.canonicalUrl, question: "Describe the selected source window", mode: "multimodal", mediaDetail: "low", startSeconds: 120, endSeconds: 124 };

async function withEnv<T>(settings: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(settings)) value === undefined ? delete process.env[key] : process.env[key] = value;
    return await action();
  } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

async function fixture(options: { height?: number; withAudio?: boolean; duration?: number; availableDuration?: number; actualVideo?: boolean; actualAudio?: boolean; advertiseVideo?: boolean } = {}) {
  const height = options.height ?? 480, width = height * 4 / 3, withAudio = options.withAudio ?? true;
  const duration = options.duration ?? 4, availableDuration = options.availableDuration ?? 4276;
  const actualVideo = options.actualVideo ?? true, actualAudio = options.actualAudio ?? withAudio;
  const advertisedVideo = options.advertiseVideo ?? true;
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-window-fixture-"));
  const media = path.join(directory, "input.mp4");
  const script = path.join(directory, "downloader.cjs");
  const log = path.join(directory, "calls.jsonl");
  try {
    await runProcess(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...(actualVideo ? ["-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=10`] : []), ...(actualAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000"] : []), "-t", String(duration), ...(actualVideo ? ["-c:v", "libx264", "-preset", "ultrafast", "-threads", "1"] : []), ...(actualAudio ? ["-c:a", "aac", "-b:a", "32k"] : []), media], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    await fs.writeFile(script, `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');const info={id:'BV1DTxXzUEvW',duration:${availableDuration},format_id:'fixture',width:${JSON.stringify(advertisedVideo ? width : null)},height:${JSON.stringify(advertisedVideo ? height : null)},fps:10,vcodec:${JSON.stringify(advertisedVideo ? 'h264' : 'none')},acodec:${JSON.stringify(withAudio ? 'aac' : 'none')},formats:[{format_id:'fixture',width:${JSON.stringify(advertisedVideo ? width : null)},height:${JSON.stringify(advertisedVideo ? height : null)},fps:10,vcodec:${JSON.stringify(advertisedVideo ? 'h264' : 'none')},acodec:${JSON.stringify(withAudio ? 'aac' : 'none')}}]};if(!args.includes('--skip-download')){const dest=args[args.indexOf('-o')+1].replace('%(ext)s','mp4');fs.copyFileSync(${JSON.stringify(media)},dest);const range=args[args.indexOf('--download-sections')+1].slice(1).split('-').map(Number);if(!process.env.CATALYST_TEST_OMIT_MARKERS){info.section_start=range[0]+Number(process.env.CATALYST_TEST_WRONG_START||0);info.section_end=process.env.CATALYST_TEST_CLAMP_SECTION_END?Math.min(range[1],info.duration):range[1];}}console.log(JSON.stringify(info));`);
    return { directory, media, script, log, env: { YTDLP_PATH: script, YTDLP_PYTHON: process.execPath, BILIBILI_COOKIES_FILE: undefined, BILIBILI_COOKIES_FROM_BROWSER: undefined, CATALYST_MAX_MEDIA_MB: "4", CATALYST_TEST_WRONG_START: undefined, CATALYST_TEST_OMIT_MARKERS: undefined, CATALYST_TEST_CLAMP_SECTION_END: undefined } };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

async function info(media: string) {
  return (await runProcess(getFfmpegPath(), ["-hide_banner", "-i", media, "-t", "1", "-f", "null", "-"], { timeout: 15_000, maxBuffer: 1024 * 1024 })).stderr;
}

async function trackDirectories(action: (directories: string[]) => Promise<void>) {
  const original = fs.mkdtemp;
  const directories: string[] = [];
  fs.mkdtemp = ((...args: unknown[]) => (Reflect.apply(original, fs, args) as Promise<string | Buffer>).then((directory) => {
    if (/catalyst-(?:media|prepared)-window-/.test(String(args[0]))) directories.push(String(directory));
    return directory;
  })) as typeof fs.mkdtemp;
  try { await action(directories); }
  finally { fs.mkdtemp = original; await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true }))); }
}

test("window download preserves the selected Bilibili part and uses source sections without a whole-source fallback", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await withEnv(f.env, async () => {
      const sourceBytes = (await fs.stat(f.media)).size;
      // Leave room for the media only: the trust bundle must not consume the
      // caller's remaining media budget.
      const acquired = await acquireMediaWindow(video, { ...request, maxAcquiredBytes: sourceBytes + 1 }, context());
      const directory = path.dirname(acquired.path);
      try {
        assert.equal(acquired.height, 480);
        assert.equal(acquired.width, 640);
        assert.equal(acquired.fps, 10);
        assert.ok(acquired.bytes! > 0);
        const calls: string[][] = (await fs.readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(calls.length, 2);
        const args = calls[1];
        assert.equal(args[args.indexOf("--download-sections") + 1], "*120-124");
        assert.ok(args.includes("--force-keyframes-at-cuts"));
        const inputArgs = args.find((arg) => arg.startsWith("ffmpeg_i:"));
        assert.ok(inputArgs);
        assert.match(inputArgs, /^ffmpeg_i:-rw_timeout 15000000 -tls_verify 1 -ca_file '/);
        const caBundle = path.join(directory, "trusted-ca.pem");
        assert.match(await fs.readFile(caBundle, "utf8"), /-----BEGIN CERTIFICATE-----/);
        assert.ok(inputArgs.includes(caBundle));
        assert.ok(args.includes(`ffmpeg_o:-loglevel error -fs ${sourceBytes + 2}`));
        assert.match(args[args.indexOf("-f") + 1], /height<=480/);
        assert.equal(args.at(-1), video.canonicalUrl);
        assert.equal(calls[0].at(-1), video.canonicalUrl);
        assert.match(await info(acquired.path), /Duration: 00:00:04\./);
      } finally { await acquired.dispose(); }
      assert.equal(await fs.access(directory).then(() => true, () => false), false);
    });
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("real FFmpeg overview and detail preparations enforce sampling, resolution and requested audio modality", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const [mode, detail, dimensions, fps] of [["multimodal", "low", "480x360", "1 fps"], ["vision", "default", "640x480", "5 fps"]] as const) {
      const prepared = await prepareResearchWindow(f.media, mode, detail, context());
      try {
        const diagnostic = await info(prepared.path);
        assert.ok(diagnostic.includes(dimensions));
        assert.ok(diagnostic.includes(fps));
        assert.match(diagnostic, /Duration: 00:00:04\./);
        assert.equal(/Stream .*Audio:/.test(diagnostic), mode === "multimodal");
        assert.ok((await fs.stat(prepared.path)).size <= 32 * 1024 * 1024);
      } finally { await prepared.dispose(); }
      assert.equal(await fs.access(prepared.directory).then(() => true, () => false), false);
    }
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("default overview accepts a sole 720p source, keeps actual dimensions and does not require audio for vision", { timeout: 30_000 }, async () => {
  for (const mode of ["multimodal", "vision"] as const) {
    const f = await fixture({ height: 720, withAudio: mode === "multimodal" });
    try {
      await withEnv(f.env, async () => {
        const acquired = await acquireMediaWindow(video, { ...request, mode }, context());
        try {
          assert.equal(acquired.height, 720);
          assert.equal(acquired.width, 960);
          const diagnostic = await info(acquired.path);
          assert.equal(/Stream .*Audio:/.test(diagnostic), mode === "multimodal");
          const calls: string[][] = (await fs.readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          const selector = calls[1][calls[1].indexOf("-f") + 1];
          assert.match(selector, /height<=480/);
          assert.match(selector, /\/fixture$/);
          if (mode === "vision") assert.doesNotMatch(selector, /\+ba|\+fixture/);
        } finally { await acquired.dispose(); }
        await assert.rejects(() => acquireMediaWindow(video, {
          ...request, mode, sourceQuality: { profile: "custom", resolution: "1080p", fps: 30, onUnavailable: "error" },
        }, context()), /Requested source quality 1080p/);
      });
    } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
  }
});

test("ignored section durations, wrong source interval markers and byte overruns fail with cleaned temporary files", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const [overrides, changedRequest, code] of [
      [{}, { ...request, endSeconds: 122 }, "INVALID_MEDIA_WINDOW"],
      [{ CATALYST_TEST_WRONG_START: "10" }, request, "INVALID_MEDIA_WINDOW"],
      [{ CATALYST_TEST_OMIT_MARKERS: "1" }, request, "INVALID_MEDIA_WINDOW"],
      [{}, { ...request, maxAcquiredBytes: 32 }, "RESOURCE_LIMIT"],
      [{ CATALYST_MAX_MEDIA_MB: "0.00001" }, request, "RESOURCE_LIMIT"],
    ] as const) {
      await withEnv({ ...f.env, ...overrides }, async () => {
        await trackDirectories(async (directories) => {
          await assert.rejects(() => acquireMediaWindow(video, changedRequest, context()), (error: unknown) => {
            assert.equal((error as { code: string }).code, code);
            assert.doesNotMatch((error as Error).message, /catalyst-window-fixture-|catalyst-media-window-/);
            return true;
          });
          assert.equal(directories.length, 1);
          assert.equal(await fs.access(directories[0]).then(() => true, () => false), false);
        });
      });
    }
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("terminal API rounding accepts the verified extractor end and reports actual acquired duration", { timeout: 30_000 }, async () => {
  const f = await fixture({ duration: 2, availableDuration: 2 });
  const terminalVideo = { ...video, durationSeconds: 2.6 };
  const terminalRequest = { ...request, startSeconds: 0, endSeconds: 2.6 };
  try {
    await withEnv({ ...f.env, CATALYST_TEST_CLAMP_SECTION_END: "1" }, async () => {
      const acquired = await acquireMediaWindow(terminalVideo, terminalRequest, context());
      try { assert.ok(Math.abs(acquired.durationSeconds! - 2) < 0.1); }
      finally { await acquired.dispose(); }
      // The same short file is not acceptable for a nonterminal source window.
      await assert.rejects(() => acquireMediaWindow({ ...video, durationSeconds: 3 }, terminalRequest, context()),
        (error: unknown) => (error as { code: string }).code === "INVALID_MEDIA_WINDOW");
    });
    await withEnv(f.env, async () => {
      // Requested markers without a clamp still cannot hide a nonterminal
      // truncation, even though the resulting media has a plausible duration.
      await assert.rejects(() => acquireMediaWindow({ ...video, durationSeconds: 3 }, terminalRequest, context()),
        (error: unknown) => (error as { code: string }).code === "INVALID_MEDIA_WINDOW");
    });
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("missing tracks are retryable only when the selected format advertised that track", { timeout: 30_000 }, async () => {
  for (const [options, code, retryable] of [
    [{ actualVideo: false }, "VIDEO_UNAVAILABLE", true],
    [{ actualVideo: false, advertiseVideo: false }, "VIDEO_UNAVAILABLE", false],
    [{ actualAudio: false }, "AUDIO_UNAVAILABLE", true],
    [{ actualAudio: false, withAudio: false }, "AUDIO_UNAVAILABLE", false],
  ] as const) {
    const f = await fixture(options);
    try {
      await withEnv(f.env, async () => {
        await trackDirectories(async (directories) => {
          await assert.rejects(() => acquireMediaWindow(video, request, context()), (error: unknown) => {
            assert.equal((error as { code: string }).code, code);
            assert.equal((error as { retryable: boolean }).retryable, retryable);
            return true;
          });
          assert.equal(await fs.access(directories[0]).then(() => true, () => false), false);
        });
      });
    } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
  }
});

test("invalid or cancelled window work stops before temp creation and subprocess launch", async () => {
  await trackDirectories(async (directories) => {
    for (const invalid of [{ ...request, startSeconds: undefined }, { ...request, endSeconds: 120 }, { ...request, startSeconds: 0, endSeconds: 901 }, { ...request, startSeconds: 4200, endSeconds: 4300 }]) {
      await assert.rejects(() => acquireMediaWindow(video, invalid, context()), (error: unknown) => (error as { code: string }).code === "INVALID_WINDOW");
    }
    const controller = new AbortController();
    controller.abort(new DOMException("Fixture cancelled", "AbortError"));
    await assert.rejects(() => acquireMediaWindow(video, request, { signal: controller.signal, deadlineMs: Date.now() + 1000 }));
    await assert.rejects(() => prepareResearchWindow("does-not-exist.mp4", "vision", "low", { signal: controller.signal, deadlineMs: Date.now() + 1000 }));
    assert.deepEqual(directories, []);
  });
});
