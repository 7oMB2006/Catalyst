import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExecutionContext, Platform, PlatformAdapter, ResearchRequest, SourceContext } from "../src/contracts.js";
import { researchVideo } from "../src/research.js";
import { analyzeTextWithProvider, transcribeAudioWithProvider } from "../src/video-analysis.js";

const request: ResearchRequest = { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", question: "Which step is stated?", mode: "language" };

function context(platform: Platform = "youtube"): SourceContext {
  return {
    video: { platform, id: platform === "youtube" ? "jNQXAC9IVRw" : "BV1Dg5W69Ecx", partId: "1", sourceUrl: request.url, canonicalUrl: request.url, title: "Fixture video", description: "Fixture source metadata", durationSeconds: 60 },
    captions: { status: "available", kind: "manual", language: "en", cues: [{ start: 0, end: 10, content: "First instruction" }, { start: 27, end: 29, content: "Second instruction" }, { start: 40, end: 45, content: "Later instruction" }] },
    comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "available" }, media: { status: "not_requested" }, comments: { status: "disabled" } },
    warnings: [],
  };
}

function adapter(source = context()): PlatformAdapter {
  return { platform: source.video.platform, supports: () => true, resolve: async () => structuredClone(source), acquire: async () => { throw new Error("Media download must not run for caption research"); } };
}

async function provider<T>(response: string, action: (prompts: string[]) => Promise<T>): Promise<T> {
  const names = ["CODEX_VIDEO_PROVIDER", "STEPFUN_BASE_URL", "STEPFUN_API_KEY"];
  const previous = names.map((name) => process.env[name]);
  const oldFetch = globalThis.fetch;
  const prompts: string[] = [];
  process.env.CODEX_VIDEO_PROVIDER = "stepfun";
  process.env.STEPFUN_BASE_URL = "https://api.stepfun.com/step_plan/v1";
  process.env.STEPFUN_API_KEY = "catalyst-test-provider-key";
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://api.stepfun.com/step_plan/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    prompts.push(typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content[1].text);
    return new Response(JSON.stringify({ choices: [{ message: { content: response } }] }), { status: 200 });
  }) as typeof fetch;
  try { return await action(prompts); }
  finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
  }
}

test("both platforms share caption research and preserve nonzero source cue times", async () => {
  for (const platform of ["bilibili", "youtube"] as const) {
    await provider(JSON.stringify({ analysis: "Second instruction", findings: [{ statement: "Second instruction", evidence_ids: ["caption:1"] }] }), async (prompts) => {
      const result = await researchVideo({ ...request, startSeconds: 25, endSeconds: 35 }, [adapter(context(platform))]);
      assert.equal(result.status, "complete");
      assert.equal(result.video?.platform, platform);
      assert.deepEqual(result.evidence.filter((item) => item.kind === "caption").map((item) => item.time_range), [{ start_seconds: 27, end_seconds: 29 }]);
      assert.match(prompts[0], /Second instruction/);
      assert.doesNotMatch(prompts[0], /First instruction|Later instruction/);
      assert.equal(result.findings[0].verification, "unverified");
      assert.equal(result.capabilities.media.status, "not_requested");
      assert.equal(result.processing.usage, null);
    });
  }
});

test("invalid windows are rejected before acquisition and duration failures preserve metadata", async () => {
  let resolved = false;
  const fake = adapter();
  fake.resolve = async () => { resolved = true; return context(); };
  const missingEnd = await researchVideo({ ...request, startSeconds: 10 }, [fake]);
  assert.equal(missingEnd.errors[0].code, "INVALID_WINDOW");
  assert.equal(resolved, false);
  const beyond = await researchVideo({ ...request, startSeconds: 25, endSeconds: 65 }, [fake]);
  assert.equal(beyond.status, "partial");
  assert.equal(beyond.errors[0].code, "INVALID_WINDOW");
  assert.equal(beyond.evidence[0].id, "metadata:1");
});

test("unknown, metadata-only and mixed hallucinated citations are rejected", async () => {
  const response = JSON.stringify({ analysis: "Unverified response", findings: [
    { statement: "Invented precise frame", evidence_ids: ["frame:999"] },
    { statement: "Title alone proves event", evidence_ids: ["metadata:1"] },
    { statement: "Partially fabricated support", evidence_ids: ["caption:1", "frame:999"] },
    { statement: "First instruction", evidence_ids: ["caption:1"] },
  ] });
  await provider(response, async () => {
    const result = await researchVideo(request, [adapter()]);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.findings.map((item) => item.statement), ["First instruction"]);
    assert.match(result.warnings.join(" "), /3 finding\(s\) were discarded/);
  });
});

test("unstructured and primitive provider answers remain uncited partial results", async () => {
  for (const response of ["A plain answer at frame 99", "null"]) {
    await provider(response, async () => {
      const result = await researchVideo(request, [adapter()]);
      assert.equal(result.status, "partial");
      assert.equal(result.findings.length, 0);
      assert.equal(result.analysis, response);
      assert.equal(result.errors.length, 0);
    });
  }
});

test("a missing model configuration preserves acquired source evidence", async () => {
  const oldKey = process.env.STEPFUN_API_KEY;
  const oldProvider = process.env.CODEX_VIDEO_PROVIDER;
  delete process.env.STEPFUN_API_KEY;
  process.env.CODEX_VIDEO_PROVIDER = "stepfun";
  try {
    const result = await researchVideo(request, [adapter()]);
    assert.equal(result.status, "partial");
    assert.equal(result.errors[0].stage, "analysis");
    assert.equal(result.errors[0].code, "CONFIGURATION_ERROR");
    assert.ok(result.evidence.some((item) => item.kind === "caption"));
  } finally {
    if (oldKey === undefined) delete process.env.STEPFUN_API_KEY; else process.env.STEPFUN_API_KEY = oldKey;
    if (oldProvider === undefined) delete process.env.CODEX_VIDEO_PROVIDER; else process.env.CODEX_VIDEO_PROVIDER = oldProvider;
  }
});

test("long media jobs request a bounded source window before downloading", async () => {
  const source = context();
  source.video.durationSeconds = 1800;
  source.captions = { status: "absent", kind: "unknown", cues: [] };
  let downloaded = false;
  const fake = adapter(source);
  fake.acquire = async () => { downloaded = true; throw new Error("Must not download"); };
  const result = await researchVideo({ ...request, mode: "vision" }, [fake]);
  assert.equal(result.errors[0].code, "WINDOW_REQUIRED");
  assert.equal(result.status, "partial");
  assert.equal(downloaded, false);
});

test("source access failures retain authentication and blocking states", async () => {
  for (const [code, status] of [["AUTH_REQUIRED", "auth_required"], ["ACCESS_BLOCKED", "blocked"]] as const) {
    const fake = adapter();
    fake.acquire = async () => { throw Object.assign(new Error("Source access requires cookies or returned HTTP 403."), { code }); };
    const result = await researchVideo({ ...request, mode: "vision" }, [fake]);
    assert.equal(result.errors[0].code, code);
    assert.equal(result.capabilities.media.status, status);
    assert.equal(result.status, "partial");
    assert.equal(result.evidence[0].id, "metadata:1");
    fake.resolve = async () => { throw Object.assign(new Error("Source access requires cookies or returned HTTP 403."), { code }); };
    const unresolved = await researchVideo(request, [fake]);
    assert.equal(unresolved.capabilities.metadata.status, status);
    assert.equal(unresolved.status, "unavailable");
  }
});

test("external cancellation reaches source work and returns a bounded failure", async () => {
  const controller = new AbortController();
  const fake = adapter();
  let receivedSignal: AbortSignal | undefined;
  fake.resolve = async (_, execution) => {
    receivedSignal = execution.signal;
    return new Promise((_, reject) => execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }));
  };
  const running = researchVideo(request, [fake], controller.signal);
  controller.abort(new DOMException("Client cancelled", "AbortError"));
  const result = await running;
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(result.status, "unavailable");
  assert.equal(result.errors[0].code, "CANCELLED");
});

test("provider options carry the cancellation signal and explicit ASR language", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "catalyst-asr-test-"));
  const audio = path.join(directory, "audio.wav");
  await fs.writeFile(audio, "test audio");
  const oldFetch = globalThis.fetch;
  const previous = { key: process.env.STEPFUN_API_KEY, provider: process.env.CODEX_VIDEO_PROVIDER, base: process.env.STEPFUN_BASE_URL };
  const execution: ExecutionContext = { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 };
  process.env.STEPFUN_API_KEY = "catalyst-test-provider-key";
  process.env.CODEX_VIDEO_PROVIDER = "stepfun";
  process.env.STEPFUN_BASE_URL = "https://api.stepfun.com/v1";
  globalThis.fetch = (async (url, init) => {
    assert.equal(init?.signal, execution.signal);
    if (String(url).endsWith("/audio/asr/sse")) {
      assert.equal(JSON.parse(String(init?.body)).audio.input.transcription.language, "en");
      return new Response('data: {"type":"transcript.text.done","text":"real transcript"}\n\n', { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await transcribeAudioWithProvider(audio, { context: execution, language: "en" }), "real transcript");
    assert.equal(await analyzeTextWithProvider("question", { context: execution }), "ok");
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of [["STEPFUN_API_KEY", previous.key], ["CODEX_VIDEO_PROVIDER", previous.provider], ["STEPFUN_BASE_URL", previous.base]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("provider errors redact credentials and signed query values", async () => {
  await provider("unused", async () => {
    globalThis.fetch = (async () => new Response('catalyst-test-provider-key https://media.example/video?token=private-value', { status: 503 })) as typeof fetch;
    const result = await researchVideo(request, [adapter()]);
    assert.equal(result.errors[0].code, "UPSTREAM_ERROR");
    assert.doesNotMatch(JSON.stringify(result.errors), /catalyst-test-provider-key|private-value/);
    assert.match(result.errors[0].message, /503/);
  });
});

test("optional comments failures do not erase language evidence", async () => {
  const source = context();
  source.comments = { status: "error", items: [], reason: "Comments unavailable" };
  source.capabilities.comments = { status: "error" };
  await provider(JSON.stringify({ analysis: "First instruction", findings: [{ statement: "First instruction", evidence_ids: ["caption:1"] }] }), async () => {
    const result = await researchVideo({ ...request, includeComments: true }, [adapter(source)]);
    assert.equal(result.status, "partial");
    assert.equal(result.findings.length, 1);
    assert.equal(result.capabilities.comments.status, "error");
  });
});

test("visual window is silent, source bounded and cleaned after analysis", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "catalyst-visual-test-"));
  const executable = path.join(directory, "fake-ffmpeg.mjs");
  const sourcePath = path.join(directory, "source.mp4");
  const log = path.join(directory, "arguments.json");
  await fs.writeFile(sourcePath, "source bytes");
  await fs.writeFile(executable, '#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync(process.env.CATALYST_TEST_FFMPEG_LOG,JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.argv.at(-1),"processed media");\n', { mode: 0o755 });
  const oldFfmpeg = process.env.FFMPEG_PATH;
  const oldLog = process.env.CATALYST_TEST_FFMPEG_LOG;
  process.env.FFMPEG_PATH = executable;
  process.env.CATALYST_TEST_FFMPEG_LOG = log;
  let disposed = false;
  const fake = adapter();
  fake.acquire = async () => ({ path: sourcePath, width: 320, height: 240, fps: 15, bytes: 12, dispose: async () => { disposed = true; } });
  try {
    await provider(JSON.stringify({ analysis: "An animal is visible", findings: [{ statement: "An animal is visible", evidence_ids: ["visual:1"] }] }), async () => {
      const result = await researchVideo({ ...request, mode: "vision", startSeconds: 25, endSeconds: 35 }, [fake]);
      assert.equal(result.status, "complete");
      const args = JSON.parse(await fs.readFile(log, "utf8"));
      assert.ok(args.includes("-an"));
      assert.equal(args[args.indexOf("-ss") + 1], "25");
      assert.equal(args[args.indexOf("-t") + 1], "10");
      await assert.rejects(fs.stat(args.at(-1)), /ENOENT/);
      const evidence = result.evidence.find((item) => item.kind === "visual")!;
      assert.deepEqual(evidence.time_range, { start_seconds: 25, end_seconds: 35 });
      assert.equal(evidence.precision, "requested_window");
      assert.equal(evidence.data?.audio_removed, true);
      assert.equal(result.findings[0].verification, "unverified");
      assert.equal(disposed, true);
    });
  } finally {
    if (oldFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = oldFfmpeg;
    if (oldLog === undefined) delete process.env.CATALYST_TEST_FFMPEG_LOG; else process.env.CATALYST_TEST_FFMPEG_LOG = oldLog;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("audio-only acquisition supports a nonzero language window without requiring video", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "catalyst-audio-window-"));
  const executable = path.join(directory, "fake-ffmpeg.mjs");
  const sourcePath = path.join(directory, "source.m4a");
  const log = path.join(directory, "arguments.json");
  await fs.writeFile(sourcePath, "audio only");
  await fs.writeFile(executable, '#!/usr/bin/env node\nimport fs from "node:fs";const args=process.argv.slice(2);if(args.includes("-map")||!args.includes("-vn"))process.exit(2);fs.writeFileSync(process.env.CATALYST_TEST_FFMPEG_LOG,JSON.stringify(args));fs.writeFileSync(args.at(-1),"audio track");\n', { mode: 0o755 });
  const oldFfmpeg = process.env.FFMPEG_PATH;
  const oldLog = process.env.CATALYST_TEST_FFMPEG_LOG;
  process.env.FFMPEG_PATH = executable;
  process.env.CATALYST_TEST_FFMPEG_LOG = log;
  const source = context();
  source.captions = { status: "absent", kind: "unknown", cues: [] };
  source.capabilities.captions = { status: "absent" };
  const fake = adapter(source);
  let disposed = false;
  fake.acquire = async () => ({ path: sourcePath, bytes: 10, dispose: async () => { disposed = true; } });
  try {
    await provider("unused", async () => {
      globalThis.fetch = (async (url, init) => {
        if (String(url).endsWith("/audio/asr/sse")) {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.audio.input.transcription.language, "en");
          return new Response('data: {"type":"transcript.text.done","text":"An audio instruction"}\n\n', { status: 200 });
        }
        const body = JSON.parse(String(init?.body));
        assert.match(body.messages[0].content, /An audio instruction/);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ analysis: "An audio instruction", findings: [{ statement: "An audio instruction", evidence_ids: ["asr:1"] }] }) } }] }), { status: 200 });
      }) as typeof fetch;
      const result = await researchVideo({ ...request, startSeconds: 25, endSeconds: 35, language: "en" }, [fake]);
      assert.equal(result.status, "complete");
      const args = JSON.parse(await fs.readFile(log, "utf8"));
      assert.equal(args[args.indexOf("-ss") + 1], "25");
      assert.equal(args[args.indexOf("-t") + 1], "10");
      const evidence = result.evidence.find((item) => item.kind === "asr")!;
      assert.equal(evidence.content, "An audio instruction");
      assert.equal(evidence.precision, "requested_window");
      assert.deepEqual(evidence.time_range, { start_seconds: 25, end_seconds: 35 });
      assert.equal(disposed, true);
    });
  } finally {
    if (oldFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = oldFfmpeg;
    if (oldLog === undefined) delete process.env.CATALYST_TEST_FFMPEG_LOG; else process.env.CATALYST_TEST_FFMPEG_LOG = oldLog;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("multimodal source evidence records audio and video channels", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "catalyst-multimodal-"));
  const mediaPath = path.join(directory, "source.mp4");
  await fs.writeFile(mediaPath, "multimodal source");
  const fake = adapter();
  let disposed = false;
  fake.acquire = async () => ({ path: mediaPath, width: 1920, height: 1080, fps: 30, dispose: async () => { disposed = true; } });
  try {
    await provider(JSON.stringify({ analysis: "Audio and picture answer", findings: [{ statement: "Audio and picture answer", evidence_ids: ["multimodal:1"] }] }), async () => {
      const result = await researchVideo({ ...request, mode: "multimodal" }, [fake]);
      assert.equal(result.status, "complete");
      const mediaEvidence = result.evidence.find((item) => item.kind === "multimodal")!;
      assert.deepEqual(mediaEvidence.data?.channels, ["audio", "video"]);
      assert.equal(mediaEvidence.data?.audio_removed, false);
      assert.deepEqual(result.findings[0].evidence_ids, ["multimodal:1"]);
      assert.equal(disposed, true);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
