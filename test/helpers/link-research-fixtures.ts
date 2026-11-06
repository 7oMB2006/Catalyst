import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Evidence, SourceContext } from "../../src/contracts.js";
import type { ComparisonInput } from "../../src/comparison-contracts.js";
import type { LongVideoDependencies, LongVideoRequest } from "../../src/long-video-contracts.js";
import type { LinkResearchTaskRecord, LinkResearchTaskStorage } from "../../src/link-research-contracts.js";
import type { NoteDependencies, NoteResearchRequest, XiaohongshuNoteSource } from "../../src/note-contracts.js";
import type { ResearchTaskHost } from "../../src/research-task-contracts.js";
import { compareResearchMaterials } from "../../src/comparison.js";
import { researchXiaohongshuNote } from "../../src/note-research.js";
import { ResearchSessionStore } from "../../src/research-session-store.js";
import { startLongVideoResearch, resumeLongVideoResearch } from "../../src/research-sessions.js";

export const VIDEO_ONE = "https://www.bilibili.com/video/BV1dPeP6REwM/";
export const VIDEO_TWO = "https://www.bilibili.com/video/BV1DTxXzUEvW/";
export const NOTE_ID = "6ae80a83000000001a0153d3";
export const NOTE_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;
export const QUESTION = "How does this tutorial divide work between an agent and its tools?";
export const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A new adapter instance can share the durable map, while callers never share mutable snapshots. */
export class MemoryLinkResearchStore implements LinkResearchTaskStorage {
  constructor(readonly records = new Map<string, LinkResearchTaskRecord>()) {}
  afterSave?: (record: LinkResearchTaskRecord) => void;
  failSave?: (record: LinkResearchTaskRecord) => boolean;
  newId() { return randomUUID(); }
  async load(id: string) {
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error("Fixture task not found"), { code: "TASK_NOT_FOUND" });
    return structuredClone(record);
  }
  async save(record: LinkResearchTaskRecord, expectedRevision: number | null) {
    if (this.failSave?.(record)) throw Object.assign(new Error("Fixture durable result write failed"), { code: "TASK_IO_ERROR" });
    const previous = this.records.get(record.id);
    assert.equal(previous?.revision ?? null, expectedRevision, "a stale task revision cannot overwrite a committed receipt");
    assert.equal(record.revision, (expectedRevision ?? 0) + 1);
    this.records.set(record.id, structuredClone(record));
    this.afterSave?.(structuredClone(record));
  }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}

function answer(prompt: string): string {
  const marker = prompt.includes("SYNTHESIS:") ? "EVIDENCE:\n\n" : "PRIMARY EVIDENCE:\n\n";
  const offset = prompt.lastIndexOf(marker);
  assert.notEqual(offset, -1, "the real engine supplies source evidence to its injected model");
  const items = JSON.parse(prompt.slice(offset + marker.length)) as Evidence[];
  const primary = items.find(item => item.kind !== "metadata");
  assert.ok(primary);
  return JSON.stringify({
    analysis: `The agent delegates execution to tools, supported by ${primary.id}.`,
    findings: [{ statement: "The agent delegates execution to tools.", evidence_ids: [primary.id], limitations: ["Fixture model interpretation."] }],
    relevance_score: 0,
  });
}

export function videoSource(url: string, duration = 120): SourceContext {
  const parsed = new URL(url), isNote = parsed.hostname.endsWith("xiaohongshu.com");
  const id = isNote ? parsed.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})/i)?.[1] : parsed.pathname.match(/\/video\/(BV[\da-z]{10})/i)?.[1];
  assert.ok(id);
  const canonicalUrl = isNote ? `https://www.xiaohongshu.com/explore/${id}` : `https://www.bilibili.com/video/${id}/${parsed.searchParams.has("p") ? `?p=${parsed.searchParams.get("p")}` : ""}`;
  return {
    video: { platform: isNote ? "xiaohongshu" : "bilibili", id, ...(isNote ? {} : { partId: id === "BV1dPeP6REwM" ? "41949663172" : "38253823575" }), sourceUrl: url, canonicalUrl, title: `Agent tutorial ${id}`, durationSeconds: duration },
    captions: { status: "absent", kind: "unknown", cues: [] }, comments: { status: "disabled", items: [] },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } }, warnings: [],
  };
}

export function engineHost(sessionDirectory: string) {
  const sessions = new ResearchSessionStore(sessionDirectory);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const windows: Array<{ url: string; start: number | undefined; end: number | undefined }> = [];
  const notePages: number[][] = [];
  const comparisons: ComparisonInput[][] = [];
  const resolutions: string[] = [];
  const settings = {
    duration: 120,
    failWindow: (_url: string, _start: number | undefined): boolean => false,
    failComparison: false,
    missingNotePages: [] as number[],
    notePageCount: 3,
    noteIsVideo: false,
  };
  const noteSource = (): XiaohongshuNoteSource => ({
    id: NOTE_ID, sourceUrl: NOTE_URL, canonicalUrl: NOTE_URL, title: "Agent workflow notes", description: "The agent chooses a tool; tools execute bounded operations.",
    contentType: settings.noteIsVideo ? "video_note" : "image_note", pages: Array.from({ length: settings.notePageCount }, (_, i) => ({ index: i + 1, url: `https://sns-webpic-qc.xhscdn.com/fixture/page-${i + 1}.jpg` })),
  });
  const noteDeps: NoteDependencies = {
    resolve: async request => { resolutions.push(request.url); return noteSource(); },
    acquire: async (_source, pages) => {
      notePages.push([...pages]);
      return { directory: "/fixture/note", pages: pages.map(index => ({ index, path: `/fixture/page-${index}.jpg` })), bytes: pages.length * 100, dispose: async () => undefined };
    },
    ocr: async pages => pages.filter(page => !settings.missingNotePages.includes(page.index)).map(page => ({ page: page.index, text: `Original page ${page.index}: the tool executes delegated work.`, method: "apple_vision", warnings: [] })),
    analyzeImages: async paths => JSON.stringify({ pages: paths.map((path, i) => ({ image_index: i + 1, observation: `Workflow diagram on original image ${path.match(/page-(\d+)/)?.[1]}.` })) }),
    analyzeText: async prompt => {
      const marker = "EVIDENCE:\n\n", offset = prompt.lastIndexOf(marker);
      assert.notEqual(offset, -1);
      const evidence = JSON.parse(prompt.slice(offset + marker.length)) as Array<{ id: string; page: number | null }>;
      const item = evidence.find(item => item.page !== null) ?? evidence[0]; assert.ok(item);
      return JSON.stringify({ analysis: `This reading pass reports original page ${item.page ?? "body"}.`, findings: [{ statement: `The inspected material on page ${item.page ?? "body"} delegates work.`, evidence_ids: [item.id], limitations: [] }] });
    },
    video: async (url, question, mode, context, language) => startLongVideoResearch({ url, question, mode, language, segmentSeconds: 120, maxSegments: 24, maxDetailWindows: 0, timeoutSeconds: Math.min(600, (context.deadlineMs - Date.now()) / 1000) }, { store: sessions, dependencies: dependencies(url), signal: context.signal }),
  };
  const dependencies = (url: string): LongVideoDependencies => ({
    resolve: async request => { resolutions.push(request.url); return videoSource(url, settings.duration); },
    acquireWindow: async (_video, request) => {
      windows.push({ url, start: request.startSeconds, end: request.endSeconds });
      if (settings.failWindow(url, request.startSeconds)) throw Object.assign(new Error("Fixture window unavailable"), { code: "FIXTURE_WINDOW_FAILED", retryable: true });
      return { path: `/fixture/window-${request.startSeconds}.mp4`, bytes: 1024, width: 854, height: 480, fps: 30, dispose: async () => undefined };
    },
    prepareWindow: async path => ({ path: `${path}.prepared`, dispose: async () => undefined }),
    transcribe: async path => `The tutorial at ${path} says the agent delegates execution to tools.`,
    analyzeMedia: async (_path, prompt) => answer(prompt),
    analyzeText: async prompt => answer(prompt),
  });
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === "analyze_long_video_url") {
      const request: LongVideoRequest = {
        url: args.url as string, question: args.question as string, mode: args.mode as LongVideoRequest["mode"], language: args.language as string | undefined,
        segmentSeconds: args.segment_seconds as number | undefined, maxSegments: args.max_segments as number | undefined,
        maxDetailWindows: args.max_detail_windows as number | undefined, detailWindowSeconds: args.detail_window_seconds as number | undefined,
        timeoutSeconds: args.timeout_seconds as number | undefined, windowTimeoutSeconds: args.window_timeout_seconds as number | undefined, maxDownloadMB: args.max_download_mb as number | undefined,
      };
      return wire(await startLongVideoResearch(request, { store: sessions, dependencies: dependencies(request.url), signal }));
    }
    if (name === "resume_long_video_research") {
      const saved = await sessions.load(args.session_id as string);
      return wire(await resumeLongVideoResearch(saved.id, { url: args.url as string | undefined, timeoutSeconds: args.timeout_seconds as number | undefined, windowTimeoutSeconds: args.window_timeout_seconds as number | undefined, maxDownloadMB: args.max_download_mb as number | undefined }, { store: sessions, dependencies: dependencies(saved.request.url), signal }));
    }
    if (name === "analyze_xiaohongshu_note") {
      const request: NoteResearchRequest = { url: args.url as string, question: args.question as string, mode: args.mode as NoteResearchRequest["mode"], language: args.language as string | undefined, startPage: args.start_page as number | undefined, endPage: args.end_page as number | undefined, timeoutSeconds: args.timeout_seconds as number | undefined };
      return wire(await researchXiaohongshuNote(request, noteDeps, signal));
    }
    assert.equal(name, "compare_research_materials");
    const materials = args.materials as ComparisonInput[]; comparisons.push(structuredClone(materials));
    return wire(await compareResearchMaterials({ question: args.question as string, materials, language: args.language as string | undefined, timeoutSeconds: args.timeout_seconds as number | undefined }, { analyzeText: async prompt => {
      if (settings.failComparison) throw Object.assign(new Error("Fixture comparison provider unavailable"), { code: "FIXTURE_COMPARISON_FAILED" });
      const marker = "QUOTE CATALOG:\n\n", offset = prompt.lastIndexOf(marker); assert.notEqual(offset, -1);
      const catalog = JSON.parse(prompt.slice(offset + marker.length)) as Array<{ id: string; material_id: string }>;
      const ids = [...new Set(catalog.map(item => item.material_id))];
      return JSON.stringify({ comparisons: [{ claim: "The agent delegates execution to tools.", positions: ids.map(id => ({ material_id: id, stance: "supports", citation_ids: [catalog.find(item => item.material_id === id)!.id], explanation: "The cited original language material describes delegated execution." })), limitations: ["These sources have not been independently verified."] }] });
    } }, signal));
  } };
  return { host, calls, windows, notePages, comparisons, resolutions, settings, sessions };
}
