import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence, SourceContext } from "../src/contracts.js";
import type { LongVideoDependencies, LongVideoRequest } from "../src/long-video-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { getAdapter } from "../src/adapters/index.js";
import { YouTubeAdapter, youtubeId } from "../src/adapters/youtube.js";
import { resolveBilibiliUrl } from "../src/adapters/bilibili.js";
import { canonicalResearchSourceUrl } from "../src/comparison-materials.js";
import { continueLinkResearchTask, getLinkResearchTask, startLinkResearchTask } from "../src/link-research.js";
import { LinkResearchTaskStore } from "../src/link-research-store.js";
import { ResearchSessionStore } from "../src/research-session-store.js";
import { startLongVideoResearch } from "../src/research-sessions.js";
import { engineHost, QUESTION, VIDEO_ONE, wire, videoSource } from "./helpers/link-research-fixtures.js";

const YOUTUBE_ID = "AbCdEF12345", YOUTUBE = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
const youtubeForms = [
  `https://music.youtube.com/watch?v=${YOUTUBE_ID}`,
  `https://www.youtube.com/live/${YOUTUBE_ID}`,
  `https://m.youtube.com/shorts/${YOUTUBE_ID}/shared`,
  `https://youtube.com/embed/${YOUTUBE_ID}/shared`,
  `https://youtu.be/${YOUTUBE_ID}/shared`,
  `http://music.youtube.com:443/watch?v=${YOUTUBE_ID}`,
  `https://www.youtube.com:80/live/${YOUTUBE_ID}`,
];
const bilibiliForms = [
  `${VIDEO_ONE}shared?p=17`,
  VIDEO_ONE.replace("https:", "http:").replace(".com/", ".com:443/") + "?p=17",
];

function modelAnswer(prompt: string): string {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const offset = prompt.lastIndexOf(marker); assert.notEqual(offset, -1);
  const evidence = (JSON.parse(prompt.slice(offset + marker.length)) as Evidence[]).find(e => e.kind !== "metadata"); assert.ok(evidence);
  return JSON.stringify({ analysis: "The agent delegates bounded work to tools.", findings: [{ statement: "The agent delegates work.", evidence_ids: [evidence.id], limitations: [] }], relevance_score: 0 });
}

async function fixture(operation: (store: LinkResearchTaskStore, host: ResearchTaskHost, calls: { research: number; resolve: number; model: number }, directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst link url forms "));
  const store = new LinkResearchTaskStore(join(directory, "tasks")), sessions = new ResearchSessionStore(join(directory, "sessions"));
  const calls = { research: 0, resolve: 0, model: 0 };
  const deps: LongVideoDependencies = {
    resolve: async (request, context) => {
      calls.resolve++;
      let source: SourceContext;
      if (getAdapter(request.url).platform === "youtube") {
        const parsed = new URL(request.url); assert.equal(new YouTubeAdapter().supports(parsed), true);
        const id = youtubeId(parsed), canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
        source = videoSource(VIDEO_ONE);
        source.video = { platform: "youtube", id, sourceUrl: request.url, canonicalUrl, title: "Fixture finite archived video", durationSeconds: 120 };
      } else {
        const resolved = await resolveBilibiliUrl(request.url, context);
        source = videoSource(resolved.canonicalUrl);
        source.video.sourceUrl = request.url;
      }
      source.captions = { status: "available", kind: "manual", cues: [{ start: 0, end: 120, content: "The agent delegates work to tools." }] };
      source.capabilities.captions = { status: "available" };
      return source;
    },
    acquireWindow: async () => { throw new Error("Caption fixtures must not acquire media."); },
    prepareWindow: async () => { throw new Error("Caption fixtures must not prepare media."); },
    transcribe: async () => { throw new Error("Caption fixtures must not transcribe."); },
    analyzeMedia: async () => { throw new Error("Caption fixtures must not analyze media."); },
    analyzeText: async prompt => { calls.model++; return modelAnswer(prompt); },
  };
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    assert.equal(name, "analyze_long_video_url"); calls.research++;
    const request: LongVideoRequest = { url: args.url as string, question: args.question as string, mode: args.mode as LongVideoRequest["mode"],
      segmentSeconds: args.segment_seconds as number, maxSegments: args.max_segments as number, maxDetailWindows: args.max_detail_windows as number,
      detailWindowSeconds: args.detail_window_seconds as number, timeoutSeconds: args.timeout_seconds as number,
      windowTimeoutSeconds: args.window_timeout_seconds as number, maxDownloadMB: args.max_download_mb as number };
    return wire(await startLongVideoResearch(request, { store: sessions, dependencies: deps, signal }));
  } };
  try { await operation(store, host, calls, directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

const input = (url: string) => ({ urls: [url], question: QUESTION, mode: "language" as const, segmentSeconds: 120, maxSegments: 2, maxDetailWindows: 0, actionTimeoutSeconds: 15, totalTimeoutSeconds: 30 });

test("adapter-supported YouTube and Bilibili URL forms retain successful engine receipts across reload and continuation", async t => {
  for (const url of [...youtubeForms, ...bilibiliForms]) await t.test(url, async () => fixture(async (store, host, calls, directory) => {
    const started = await startLinkResearchTask(input(url), { store, host });
    assert.equal(started.task.status, "completed"); assert.equal(started.task.actions[0].state, "recorded");
    assert.equal(calls.research, 1); assert.equal(calls.resolve, 1); assert.ok(calls.model > 0);
    const effects = structuredClone(calls), freshStore = new LinkResearchTaskStore(join(directory, "tasks"));
    assert.deepEqual(await getLinkResearchTask(started.task.id, { store: freshStore }), started);
    assert.deepEqual(await continueLinkResearchTask(started.task.id, {}, { store: freshStore, host }), started);
    assert.deepEqual(calls, effects, "confirmed calls must not replay after reloading the alias receipt");
  }));
});

test("fresh YouTube URL aliases preserve the saved source and reject foreign identities before research", async () => fixture(async (store, host, calls) => {
  const started = await startLinkResearchTask(input(YOUTUBE), { store, host }), effects = structuredClone(calls);
  for (const url of youtubeForms) assert.deepEqual(await continueLinkResearchTask(started.task.id, { sourceUrls: [{ sourceId: "source:1", url }] }, { store, host }), started);
  for (const url of ["https://music.youtube.com/watch?v=abcdefghijk", `https://music.youtube.com.evil.example/watch?v=${YOUTUBE_ID}`]) {
    await assert.rejects(continueLinkResearchTask(started.task.id, { sourceUrls: [{ sourceId: "source:1", url }] }, { store, host }));
  }
  assert.deepEqual(calls, effects);
}));

test("www.b23.tv shares accept confirmed receipts and a fresh URL for the same opaque share path", async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [], share = "https://www.b23.tv/fixtureShare";
  globalThis.fetch = async raw => {
    const url = String(raw); requests.push(url); assert.equal(new URL(url).hostname, "www.b23.tv");
    return new Response(null, { status: 302, headers: { location: VIDEO_ONE } });
  };
  try {
    await fixture(async (store, host, calls, directory) => {
      const started = await startLinkResearchTask(input(share), { store, host });
      assert.equal(started.task.status, "completed"); assert.equal(started.task.actions[0].state, "recorded"); assert.equal(requests.length, 1);
      const effects = structuredClone(calls), freshStore = new LinkResearchTaskStore(join(directory, "tasks"));
      assert.deepEqual(await getLinkResearchTask(started.task.id, { store: freshStore }), started);
      assert.deepEqual(await continueLinkResearchTask(started.task.id, { sourceUrls: [{ sourceId: "source:1", url: `${share}?share_source=renewed` }] }, { store: freshStore, host }), started);
      await assert.rejects(continueLinkResearchTask(started.task.id, { sourceUrls: [{ sourceId: "source:1", url: "https://www.b23.tv/anotherShare" }] }, { store, host }));
      assert.deepEqual(calls, effects); assert.equal(requests.length, 1);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("adapter-supported Xiaohongshu .cn share aliases retain note evidence and same-path access refresh", async t => {
  for (const hostname of ["xhslink.cn", "www.xhslink.cn"]) await t.test(hostname, async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "catalyst note share aliases "));
    try {
      const share = `https://${hostname}/fixtureShare`, store = new LinkResearchTaskStore(join(directory, "tasks"));
      const engine = engineHost(join(directory, "sessions"));
      const started = await startLinkResearchTask(input(share), { store, host: engine.host });
      assert.equal(started.task.status, "completed"); assert.equal(started.task.actions[0].state, "recorded");
      assert.equal(started.materials[0].kind, "note");
      const effects = structuredClone(engine.calls), freshStore = new LinkResearchTaskStore(join(directory, "tasks"));
      assert.deepEqual(await getLinkResearchTask(started.task.id, { store: freshStore }), started);
      assert.deepEqual(await continueLinkResearchTask(started.task.id, { sourceUrls: [{ sourceId: "source:1", url: `${share}?xsec_token=refreshed-in-memory` }] }, { store: freshStore, host: engine.host }), started);
      await assert.rejects(continueLinkResearchTask(started.task.id, { sourceUrls: [{ sourceId: "source:1", url: `https://${hostname}/anotherShare` }] }, { store, host: engine.host }));
      assert.deepEqual(engine.calls, effects);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

test("URL-form normalization retains exact identities, selected parts and ambiguity guards", () => {
  for (const raw of youtubeForms) assert.equal(canonicalResearchSourceUrl(raw, "youtube", YOUTUBE_ID), YOUTUBE);
  for (const raw of bilibiliForms) assert.equal(canonicalResearchSourceUrl(raw, "bilibili", "BV1dPeP6REwM"), `${VIDEO_ONE}?p=17`);
  for (const raw of [
    `https://music.youtube.com/watch?v=${YOUTUBE_ID}&v=${YOUTUBE_ID}`,
    `https://music.youtube.com/watch?v=${YOUTUBE_ID}&v=abcdefghijk`,
    `https://music.youtube.com/live/abcdefghijk`,
    `https://www.youtube.com:8080/live/${YOUTUBE_ID}`,
    `https://user:password@www.youtube.com/live/${YOUTUBE_ID}`,
    `https://www.youtube.com.evil.example/live/${YOUTUBE_ID}`,
  ]) assert.throws(() => canonicalResearchSourceUrl(raw, "youtube", YOUTUBE_ID));
  for (const raw of [`${VIDEO_ONE}?p=17&p=17`, `${VIDEO_ONE}?p=0`, VIDEO_ONE.replace("REwM", "REwm"), VIDEO_ONE.replace(".com/", ".com:8080/")]) {
    assert.throws(() => canonicalResearchSourceUrl(raw, "bilibili", "BV1dPeP6REwM"));
  }
});
