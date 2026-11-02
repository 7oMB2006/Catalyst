import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAdapter, BilibiliAdapter, YouTubeAdapter } from "../src/adapters/index.js";
import { parseJson3Captions } from "../src/adapters/youtube.js";
import { resolveBilibiliUrl } from "../src/adapters/bilibili.js";
import { credentialArgs, downloadMedia, inspectDownloader, runYtDlp } from "../src/acquisition.js";
import type { ExecutionContext, ResearchRequest } from "../src/contracts.js";

function context(ms = 5000): ExecutionContext { return { signal: AbortSignal.timeout(ms), deadlineMs: Date.now() + ms }; }
const request: ResearchRequest = { url: "https://www.bilibili.com/video/BV1Dg5W69Ecx/?p=2", question: "What is said?", mode: "language", language: "en" };

async function withEnv<T>(settings: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("platform routing validates actual hosts and rejects credentials, ports and non-web URLs", () => {
  assert.equal(getAdapter("https://youtu.be/jNQXAC9IVRw").platform, "youtube");
  assert.equal(getAdapter("https://www.youtube.com/shorts/jNQXAC9IVRw").platform, "youtube");
  assert.equal(getAdapter(request.url).platform, "bilibili");
  for (const url of ["https://youtube.com.evil.test/watch?v=jNQXAC9IVRw", "https://evil.test/BV1Dg5W69Ecx", "file:///tmp/test", "https://user:password@youtube.com/watch?v=jNQXAC9IVRw", "https://youtube.com:8123/watch?v=jNQXAC9IVRw"]) assert.throws(() => getAdapter(url));
});

test("Bilibili part selection uses matching cid, duration and caption language", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input); requests.push(url);
      assert.ok(init?.signal);
      if (url.includes("/x/web-interface/view")) return Response.json({ code: 0, data: { cid: 111, aid: 10, duration: 120, title: "Two parts", owner: { name: "Uploader" }, pages: [{ cid: 111, duration: 60 }, { cid: 222, duration: 30 }] } });
      if (url.includes("/x/tag/archive/tags")) return Response.json({ code: 0, data: [{ tag_name: "research" }] });
      if (url.includes("/x/player/v2")) {
        assert.match(url, /cid=222/);
        return Response.json({ code: 0, data: { subtitle: { subtitles: [{ lan: "zh", subtitle_url: "https://subtitle.test/chinese.json" }, { lan: "en", subtitle_url: "https://subtitle.test/english.json" }] } } });
      }
      if (url === "https://subtitle.test/english.json") return Response.json({ body: [{ from: 5, to: 9, content: "Part two caption" }] });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const result = await new BilibiliAdapter().resolve(request, context());
    assert.equal(result.video.partId, "222");
    assert.equal(result.video.durationSeconds, 30);
    assert.equal(result.video.canonicalUrl, request.url);
    assert.equal(result.captions.language, "en");
    assert.deepEqual(result.captions.cues, [{ start: 5, end: 9, content: "Part two caption" }]);
    assert.equal(result.comments.status, "disabled");
    assert.equal(requests.some((url) => url.includes("reply")), false);
  } finally { globalThis.fetch = original; }
});

test("Bilibili subtitles distinguish missing tracks from an API failure", async () => {
  const original = globalThis.fetch;
  let captionStatus = 0;
  try {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/x/web-interface/view")) return Response.json({ code: 0, data: { aid: 1, cid: 2, title: "Video", duration: 30 } });
      if (url.includes("/x/tag/archive/tags")) return Response.json({ code: 0, data: [] });
      if (url.includes("/x/player/v2")) return Response.json({ code: captionStatus, data: { subtitle: { subtitles: [] } } });
      throw new Error("Unexpected URL");
    }) as typeof fetch;
    const adapter = new BilibiliAdapter();
    const noTrack = await adapter.resolve({ ...request, url: "https://www.bilibili.com/video/BV1Dg5W69Ecx/" }, context());
    assert.equal(noTrack.captions.status, "absent");
    captionStatus = -400;
    const failed = await adapter.resolve({ ...request, url: "https://www.bilibili.com/video/BV1Dg5W69Ecx/" }, context());
    assert.equal(failed.captions.status, "error");
    assert.equal(failed.video.id, noTrack.video.id);
  } finally { globalThis.fetch = original; }
});

test("Bilibili share redirects cannot leave approved platform hosts", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async (_input, init) => { calls += 1; assert.equal(init?.redirect, "manual"); return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); }) as typeof fetch;
    await assert.rejects(() => resolveBilibiliUrl("https://b23.tv/test", context()), /supported public Bilibili hosts/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("JSON3 cues preserve platform timing and reject untimed or empty events", () => {
  const cues = parseJson3Captions({ events: [
    { tStartMs: 1200, dDurationMs: 900, segs: [{ utf8: "hello" }, { utf8: " world" }] },
    { tStartMs: 0, segs: [{ utf8: "no end" }] },
    { tStartMs: -1, dDurationMs: 100, segs: [{ utf8: "invalid" }] },
    { tStartMs: 200, dDurationMs: 100, segs: [{ utf8: "\n" }] },
  ] });
  assert.deepEqual(cues, [{ start: 1.2, end: 2.1, content: "hello world" }]);
});

async function fakeDownloader() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-adapter-test-"));
  const script = path.join(directory, "downloader.cjs");
  const log = path.join(directory, "args.json");
  await fs.writeFile(script, `const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(args));
if(args.includes('--fail')){process.stderr.write('ERROR: https://media.test/file?token=private-token and sk-testsecret');process.exit(1);}
if(args.includes('--hang')){setTimeout(()=>{},5000);}else if(args.includes('--write-subs')||args.includes('--write-auto-subs')){const template=args[args.indexOf('-o')+1];fs.writeFileSync(template.replace('%(ext)s',args.includes('--write-auto-subs')?'zh.json3':'en.json3'),JSON.stringify({events:[{tStartMs:1000,dDurationMs:2000,segs:[{utf8:'A platform caption'}]}]}));}
else {console.log(JSON.stringify({id:'jNQXAC9IVRw',title:'Test sample',duration:19,language:'en',formats:[{format_id:'18',vcodec:'h264',acodec:'aac',width:320,height:240,fps:15}],subtitles:{en:[{ext:'json3'}]},automatic_captions:{zh:[{ext:'json3'}]}}));}`);
  return { directory, script, log };
}

test("YouTube uses manual or automatic language tracks and keeps platform credentials isolated", async () => {
  const fake = await fakeDownloader();
  const youtubeCookie = path.join(fake.directory, "youtube-cookies.txt");
  const biliCookie = path.join(fake.directory, "bilibili-cookies.txt");
  await fs.writeFile(youtubeCookie, "test fixture, not a real cookie");
  await fs.writeFile(biliCookie, "test fixture, not a real cookie");
  try {
    await withEnv({ YTDLP_PATH: fake.script, YTDLP_PYTHON: process.execPath, YOUTUBE_COOKIES_FILE: youtubeCookie, BILIBILI_COOKIES_FILE: biliCookie }, async () => {
      const adapter = new YouTubeAdapter();
      const english = await adapter.resolve({ ...request, url: "https://youtu.be/jNQXAC9IVRw", language: "en", includeComments: true }, context());
      assert.equal(english.video.canonicalUrl, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
      assert.equal(english.captions.kind, "manual");
      assert.equal(english.comments.status, "unsupported");
      const chinese = await adapter.resolve({ ...request, url: english.video.canonicalUrl, language: "zh" }, context());
      assert.equal(chinese.captions.kind, "unknown");
      assert.match(chinese.warnings.join(" "), /translated origin is unverified/);
      assert.equal(chinese.captions.cues[0].start, 1);
      const args = JSON.parse(await fs.readFile(fake.log, "utf8")) as string[];
      assert.ok(args.includes("--ignore-config"));
      assert.ok(args.includes(youtubeCookie));
      assert.ok(!args.includes(biliCookie));
      assert.ok(args.includes(`node:${process.execPath}`));
      const biliAuth = await credentialArgs("bilibili");
      assert.deepEqual(biliAuth, ["--cookies", biliCookie]);
      await assert.rejects(() => downloadMedia(english.video, { ...request, sourceQuality: { profile: "standard" } }, context()), /Requested source quality/);
    });
  } finally { await fs.rm(fake.directory, { recursive: true, force: true }); }
});

test("downloader cancellation is bounded and diagnostics omit signed URL parameters", async () => {
  const fake = await fakeDownloader();
  try {
    await withEnv({ YTDLP_PATH: fake.script, YTDLP_PYTHON: process.execPath, YOUTUBE_COOKIES_FILE: undefined, YOUTUBE_COOKIES_FROM_BROWSER: undefined }, async () => {
      await assert.rejects(() => runYtDlp(["--fail"], "youtube", context()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-token|sk-testsecret/);
        return true;
      });
      await assert.rejects(() => runYtDlp(["--hang"], "youtube", context(50)), /cancelled|deadline|timed out/);
    });
  } finally { await fs.rm(fake.directory, { recursive: true, force: true }); }
});

test("downloader overrides are interpreted without executing or reading credentials", () => {
  assert.deepEqual(inspectDownloader({ YTDLP_PATH: "/tools/downloader", YTDLP_PYTHON: "/tools/python" }), { command: "/tools/python", prefixArgs: ["/tools/downloader"], source: "override" });
});
