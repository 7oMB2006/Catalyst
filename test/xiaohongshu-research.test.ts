import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ResearchRequest } from "../src/contracts.js";
import { researchVideo } from "../src/research.js";
import { researchResultSchema } from "../src/result-schema.js";
import { getFfmpegPath } from "../src/video-analysis.js";

const execFile = promisify(execFileCallback);
const NOTE_ID = "674051740000000007027a15";
const PUBLIC_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;
const ACQUISITION_URL = `${PUBLIC_URL}?xsec_token=fixture-share-token&xsec_source=app_share`;
const request: ResearchRequest = {
  url: `推荐一个演示视频 ${ACQUISITION_URL}，复制后打开小红书查看！`,
  question: "What does this demonstration show?",
  mode: "language", language: "zh", startSeconds: 1, endSeconds: 3, timeoutSeconds: 20,
};

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

function metadata(): Record<string, unknown> {
  return {
    id: NOTE_ID, title: "Fixture source", uploader: "Fixture uploader", duration: 4,
    formats: [{ format_id: "fixture", ext: "mp4", vcodec: "h264", acodec: "aac", width: 160, height: 120, fps: 10 }],
    url: "https://cdn.invalid/video?token=fixture-private-media-token",
    http_headers: { Cookie: "fixture-private-cookie" },
  };
}

async function fakeDownloader() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-xhs-engine-"));
  const config = path.join(directory, "metadata.json");
  const log = path.join(directory, "downloader.jsonl");
  const script = path.join(directory, "downloader.cjs");
  const video = path.join(directory, "fixture.mp4");
  const audio = path.join(directory, "fixture.m4a");
  await fs.writeFile(config, JSON.stringify(metadata()));
  await fs.writeFile(script, `const fs=require('node:fs');
const args=process.argv.slice(2);const data=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));
let output;
if(data._fixture_error){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args})+'\\n');process.stderr.write(data._fixture_error);process.exit(1);}
if(args.includes('--print-json')){
  const audioOnly=args[args.indexOf('-f')+1]==='bestaudio/best';
  output=args[args.indexOf('-o')+1].replace('%(ext)s',audioOnly?'m4a':'mp4');
  fs.copyFileSync(audioOnly?${JSON.stringify(audio)}:${JSON.stringify(video)},output);
  Object.assign(data,audioOnly?{ext:'m4a',format_id:'audio',vcodec:'none',acodec:'aac'}:{ext:'mp4',format_id:'fixture',vcodec:'h264',acodec:'aac',width:160,height:120,fps:10});
}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,output})+'\\n');console.log(JSON.stringify(data));`);
  return {
    directory, video, audio, log,
    update: (value: Record<string, unknown>) => fs.writeFile(config, JSON.stringify(value)),
    run: <T>(action: () => Promise<T>) => withEnv({
      YTDLP_PATH: script, YTDLP_PYTHON: process.execPath,
      XIAOHONGSHU_COOKIES_FILE: undefined, XIAOHONGSHU_COOKIES_FROM_BROWSER: undefined,
      CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_API_KEY: "catalyst-fixture-provider-key",
      STEPFUN_BASE_URL: "https://api.stepfun.com/step_plan/v1",
    }, action),
  };
}

async function inspectMedia(filename: string): Promise<string> {
  const result = await execFile(getFfmpegPath(), ["-hide_banner", "-i", filename, "-f", "null", "-"], { timeout: 10_000 });
  return result.stderr;
}

test("Xiaohongshu share text reaches all three shared modes with private acquisition URLs and real bounded media", { timeout: 60_000 }, async (t) => {
  const fake = await fakeDownloader();
  const ffmpeg = getFfmpegPath();
  const oldFetch = globalThis.fetch;
  try {
    await execFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fake.video,
    ], { timeout: 10_000 });
    await execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", fake.video, "-vn", "-c:a", "copy", fake.audio], { timeout: 10_000 });
    await fake.run(async () => withEnv({ FFMPEG_PATH: ffmpeg }, async () => {
      for (const mode of ["language", "vision", "multimodal"] as const) {
        await t.test(mode, async () => {
          await fs.writeFile(fake.log, "");
          const calls: string[] = [];
          const evidenceId = mode === "language" ? "asr:1" : `${mode === "vision" ? "visual" : "multimodal"}:1`;
          globalThis.fetch = (async (url, init) => {
            const endpoint = String(url);
            calls.push(endpoint);
            assert.ok(init?.signal);
            const body = JSON.parse(String(init?.body));
            if (endpoint.endsWith("/audio/asr/sse")) {
              assert.equal(mode, "language");
              assert.equal(body.audio.input.transcription.language, "zh");
              const bytes = Buffer.from(body.audio.data, "base64");
              assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
              assert.equal(bytes.subarray(8, 12).toString(), "WAVE");
              assert.equal(bytes.readUInt16LE(22), 1, "ASR receives mono audio");
              assert.equal(bytes.readUInt32LE(24), 16_000);
              const submitted = path.join(fake.directory, "submitted-audio.wav");
              await fs.writeFile(submitted, bytes);
              const streams = await inspectMedia(submitted);
              assert.match(streams, /Duration: 00:00:02\.00/);
              assert.match(streams, /Audio:/);
              assert.doesNotMatch(streams, /Video:/);
              return new Response('data: {"type":"transcript.text.done","text":"Turn the blue dial."}\n\n', { status: 200 });
            }
            assert.equal(endpoint, "https://api.stepfun.com/step_plan/v1/chat/completions");
            const content = body.messages[0].content;
            const prompt = typeof content === "string" ? content : content.find((part: { type: string }) => part.type === "text").text;
            assert.doesNotMatch(prompt, /fixture-share-token|fixture-private|xsec_token/);
            if (mode === "language") {
              assert.equal(typeof content, "string");
              assert.match(prompt, /Turn the blue dial/);
            } else {
              const part = content.find((item: { type: string }) => item.type === "video_url");
              assert.match(part.video_url.url, /^data:video\/mp4;base64,/);
              const submitted = path.join(fake.directory, `submitted-${mode}.mp4`);
              await fs.writeFile(submitted, Buffer.from(part.video_url.url.split(",")[1], "base64"));
              const streams = await inspectMedia(submitted);
              assert.match(streams, /Duration: 00:00:02\.00/);
              assert.match(streams, /Video:/);
              if (mode === "vision") assert.doesNotMatch(streams, /Audio:/, "vision submission actually has no audio stream");
              else assert.match(streams, /Audio:/, "multimodal submission retains audio");
            }
            return Response.json({ choices: [{ message: { content: JSON.stringify({
              analysis: "Fixture answer", findings: [{ statement: "Fixture observation", evidence_ids: [evidenceId] }],
            }) } }] });
          }) as typeof fetch;
          const result = researchResultSchema.parse(await researchVideo({ ...request, mode }));
          assert.equal(result.status, "complete", JSON.stringify(result.errors));
          assert.deepEqual(result.errors, []);
          assert.equal(result.video?.platform, "xiaohongshu");
          assert.equal(result.video?.canonicalUrl, PUBLIC_URL);
          assert.equal(result.video?.sourceUrl, PUBLIC_URL);
          assert.equal(result.request.url, PUBLIC_URL);
          assert.equal(result.capabilities.captions.status, mode === "language" ? "unsupported" : "not_requested");
          assert.equal(result.capabilities.comments.status, "disabled");
          assert.equal(result.capabilities.media.status, "available");
          const evidence = result.evidence.find((item) => item.id === evidenceId)!;
          assert.equal(evidence.source.platform, "xiaohongshu");
          assert.equal(evidence.source.url, PUBLIC_URL);
          assert.deepEqual(evidence.time_range, { start_seconds: 1, end_seconds: 3 });
          assert.equal(evidence.precision, "requested_window");
          if (mode === "vision") assert.equal(evidence.data?.audio_removed, true);
          if (mode === "multimodal") assert.deepEqual(evidence.data?.channels, ["audio", "video"]);
          assert.equal(result.findings[0].verification, "unverified");
          assert.deepEqual(result.findings[0].evidence_ids, [evidenceId]);
          assert.doesNotMatch(JSON.stringify(result), /fixture-share-token|fixture-private|xsec_token|xsec_source|cdn\.invalid/);
          assert.equal(calls.length, mode === "language" ? 2 : 1);
          const downloads = (await fs.readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; output?: string });
          assert.equal(downloads.length, 3, "resolve, acquire probe and download all use the same source");
          for (const download of downloads) {
            assert.equal(download.args.at(-1), ACQUISITION_URL, "share parameters reach every acquisition call");
            assert.ok(!download.args.includes("--cookies-from-browser"));
            if (download.output) await assert.rejects(fs.stat(download.output), /ENOENT/, "downloaded media is cleaned after research");
          }
        });
      }
    }));
  } finally {
    globalThis.fetch = oldFetch;
    await fs.rm(fake.directory, { recursive: true, force: true });
  }
});

test("Xiaohongshu engine reports inaccessible formats separately from an explicit image note without calling a provider", async () => {
  const fake = await fakeDownloader();
  const oldFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw new Error("Source failure must stop before any provider call"); }) as typeof fetch;
  try {
    await fake.run(async () => {
      for (const [data, expected] of [
        [{ ...metadata(), formats: [] }, "MEDIA_UNAVAILABLE"],
        [{ ...metadata(), note_type: "normal" }, "UNSUPPORTED_CONTENT"],
        [{ _fixture_error: `ERROR: No video formats found! ${ACQUISITION_URL}` }, "MEDIA_UNAVAILABLE"],
        [{ _fixture_error: `ERROR: HTTP Error 403: Forbidden ${ACQUISITION_URL}` }, "ACCESS_BLOCKED"],
      ] as const) {
        await fake.update(data);
        const result = researchResultSchema.parse(await researchVideo({ ...request, mode: "vision" }));
        assert.equal(result.status, "unavailable");
        assert.equal(result.video, null);
        assert.deepEqual(result.evidence, []);
        assert.deepEqual(result.findings, []);
        assert.equal(result.analysis, null);
        assert.equal(result.errors[0].code, expected);
        assert.equal(result.errors[0].stage, "resolve");
        assert.equal(result.capabilities.metadata.status, expected === "ACCESS_BLOCKED" ? "blocked" : "error");
        assert.equal(result.capabilities.media.status, "not_requested");
        assert.doesNotMatch(JSON.stringify(result), /fixture-share-token|xsec_token|xsec_source|fixture-private/);
      }
      assert.equal(providerCalls, 0);
    });
  } finally {
    globalThis.fetch = oldFetch;
    await fs.rm(fake.directory, { recursive: true, force: true });
  }
});
