#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSilentVideo, analyzeWithProvider, createSilentWindow, removeTemporaryWindow } from "./video-analysis.js";
import { researchBilibiliVideo } from "./bilibili.js";
import { researchXiaohongshuNote } from "./note-research.js";
import { xiaohongshuResearchResultShape } from "./note-result-schema.js";
import { researchVideo } from "./research.js";
import { followUpLongVideoResearch, startLongVideoResearch, resumeLongVideoResearch, sanitizeSessionResult } from "./research-sessions.js";
import { ResearchSessionStore } from "./research-session-store.js";
import { longVideoResultShape } from "./long-video-schema.js";
import { researchResultShape } from "./result-schema.js";
import { discoverBilibiliVideos } from "./discovery.js";
import { discoveryResultShape } from "./discovery-schema.js";

const server = new McpServer({ name: "catalyst-video-research-mcp", version: "0.1.0-preview.1" });

function result(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failed(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

const commonSchema = {
  video_path: z.string().min(1).describe("Absolute path to a local video file."),
  question: z.string().min(3).describe("A visual-only research question about observable actions or interactions."),
  media_detail: z.enum(["low", "default"]).default("default").describe("Use low for a long coarse pass; use default for movement, small objects, and precise inspection."),
};

const sourceQualitySchema = z.object({
  profile: z.enum(["standard", "high", "custom"]).default("standard").describe("standard targets 1080p30; high targets 1440p30; custom requires explicit resolution and fps."),
  resolution: z.enum(["720p", "1080p", "1440p", "2160p"]).optional().describe("Target source-video resolution. Overrides the profile preset."),
  fps: z.union([z.literal(30), z.literal(60)]).optional().describe("Target source-video frame rate. Overrides the profile preset."),
  on_unavailable: z.enum(["error", "warn"]).default("error").describe("error refuses an unavailable target instead of silently downgrading; warn allows a reported fallback."),
}).optional().describe("Optional source acquisition quality. It affects platform downloads, not local-video tools.");

server.registerTool("discover_bilibili_videos", {
  title: "Discover Bilibili Video Candidates",
  description: "Find bounded video candidates for a research question from anonymous Bilibili search metadata. Supply up to three short queries planned by the host; otherwise the question itself is searched. Reads one page per query, merges duplicate identities and fuses ranks with RRF. Titles, snippets and ranks are untrusted metadata, not read source evidence. Media access is not checked; source and selected-part identity must be resolved by a research tool after selection. No downloads, ASR, models, automatic retries or browser sessions. Stops on platform blocks, authentication requirements or rate limits and retains earlier candidates.",
  inputSchema: z.strictObject({
    question: z.string().trim().min(3).max(2000).describe("Research question. When queries is omitted, the question must be a short search query of at most 200 characters."),
    queries: z.array(z.string().trim().min(2).max(200)).min(1).max(3).optional().describe("One to three explicit search queries, such as a topic and alternative terminology. No model query rewriting is performed."),
    max_candidates: z.number().int().min(1).max(20).default(10).describe("Maximum unique candidates returned; this is not a promise to fill the list or exhaust the search."),
    timeout_seconds: z.number().min(1).max(120).default(30).describe("Shared deadline for all queries and response bodies."),
  }),
  outputSchema: discoveryResultShape,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ question, queries, max_candidates, timeout_seconds }, extra) => {
  const discovery = await discoverBilibiliVideos({ question, queries, maxCandidates: max_candidates, timeoutSeconds: timeout_seconds }, {}, extra.signal);
  return { content: [{ type: "text" as const, text: JSON.stringify(discovery, null, 2) }], structuredContent: { ...discovery }, isError: discovery.status === "unavailable" };
});

server.registerTool("analyze_video", {
  title: "Analyze a Video Visually",
  description: "Creates an audio-free copy of a local video and sends it to the configured video-analysis provider for visual research. Visible interfaces, code, charts, labels, and subtitles remain usable visual evidence.",
  inputSchema: commonSchema,
  annotations: { readOnlyHint: true },
}, async ({ video_path, question, media_detail }) => {
  let directory: string | undefined;
  try {
    const silent = await createSilentVideo(video_path);
    directory = silent.directory;
    return result(await analyzeWithProvider({
      videoPath: silent.videoPath,
      question,
      mediaDetail: media_detail,
    }));
  } catch (error) {
    return failed(error);
  } finally {
    if (directory) await removeTemporaryWindow(directory);
  }
});

server.registerTool("inspect_video_window", {
  title: "Inspect a Precise Video Window",
  description: "Extracts an audio-free temporary clip for the requested source-video time window, then sends that clip to the configured video-analysis provider for visual-only analysis. Temporary media and remote uploads are removed after the answer.",
  inputSchema: {
    ...commonSchema,
    start_seconds: z.number().min(0).describe("Start time in seconds in the source video."),
    end_seconds: z.number().positive().describe("End time in seconds in the source video; must be after start_seconds."),
  },
  annotations: { readOnlyHint: true },
}, async ({ video_path, question, media_detail, start_seconds, end_seconds }) => {
  let directory: string | undefined;
  try {
    const window = await createSilentWindow(video_path, start_seconds, end_seconds);
    directory = window.directory;
    return result(await analyzeWithProvider({
      videoPath: window.clipPath,
      question,
      mediaDetail: media_detail,
      sourceStartSeconds: start_seconds,
      sourceEndSeconds: end_seconds,
    }));
  } catch (error) {
    return failed(error);
  } finally {
    if (directory) {
      await removeTemporaryWindow(directory);
    }
  }
});

server.registerTool("analyze_bilibili_video", {
  title: "Research a Bilibili Video",
  description: "Resolves a public Bilibili URL, always returns public metadata and an explicit community-context status, and optionally samples 20 most-liked root comments while displaying only 3 hot comments plus up to 2 distinct high-signal comments. Supports language-only, visual-only, and multimodal research.",
  inputSchema: {
    url: z.string().url().describe("Public Bilibili video URL, including b23.tv short URLs."),
    question: z.string().min(3).describe("The research question."),
    mode: z.enum(["language", "vision", "multimodal"]).describe("language: captions then audio only; vision: silent video only; multimodal: original video with both channels."),
    media_detail: z.enum(["low", "default"]).default("default").describe("Use low for a broad long-video pass and default for close inspection."),
    include_comments: z.boolean().default(true).describe("Include untrusted community context. Fetches at most 20 most-liked root comments, presents only 3-5 representative comments, and reports empty or fetch-failed status explicitly."),
    source_quality: sourceQualitySchema,
    start_seconds: z.number().min(0).optional().describe("Optional source-video interval start in seconds. Provide together with end_seconds."),
    end_seconds: z.number().positive().optional().describe("Optional source-video interval end in seconds. Provide together with start_seconds."),
  },
  annotations: { readOnlyHint: true },
}, async ({ url, question, mode, media_detail, include_comments, source_quality, start_seconds, end_seconds }) => {
  try {
    return result(await researchBilibiliVideo({
      url,
      question,
      mode,
      mediaDetail: media_detail,
      includeComments: include_comments,
      sourceQuality: source_quality
        ? {
          profile: source_quality.profile,
          resolution: source_quality.resolution,
          fps: source_quality.fps,
          onUnavailable: source_quality.on_unavailable,
        }
        : undefined,
      startSeconds: start_seconds,
      endSeconds: end_seconds,
    }));
  } catch (error) {
    return failed(error);
  }
});

server.registerTool("analyze_video_url", {
  title: "Research a Video with Catalyst",
  description: "Research a public Bilibili or YouTube video, or an accessible Xiaohongshu video note, using a shared language, vision or multimodal workflow. Xiaohongshu accepts note links, official short links or full share text; platform captions and comments are unsupported and language mode uses ASR. Live Xiaohongshu acquisition remains experimental. Returns structured evidence, capability states, source-time precision and explicitly unverified model findings. Source quality follows the available source unless explicitly requested. Comments are opt-in.",
  inputSchema: {
    url: z.string().min(1).max(8192).describe("Public video URL, or Xiaohongshu share text containing exactly one supported note/short URL. Keep original share query parameters for acquisition."),
    question: z.string().min(3),
    mode: z.enum(["language", "vision", "multimodal"]),
    media_detail: z.enum(["low", "default"]).default("default"),
    include_comments: z.boolean().default(false),
    language: z.string().min(2).max(20).optional().describe("Preferred caption and ASR language, for example en or zh."),
    source_quality: sourceQualitySchema,
    start_seconds: z.number().min(0).optional().describe("Source-video interval start. Provide together with end_seconds; URL timestamp parameters do not set the research window."),
    end_seconds: z.number().positive().optional().describe("Source-video interval end, after start_seconds and within the source duration. Media windows are limited to 900 seconds."),
    timeout_seconds: z.number().min(5).max(600).default(240).describe("Overall research deadline in seconds, including acquisition and model calls."),
  },
  outputSchema: researchResultShape,
  annotations: { readOnlyHint: true },
}, async ({ url, question, mode, media_detail, include_comments, language, source_quality, start_seconds, end_seconds, timeout_seconds }, extra) => {
  const research = await researchVideo({
    url, question, mode, mediaDetail: media_detail, includeComments: include_comments,
    language, startSeconds: start_seconds, endSeconds: end_seconds, timeoutSeconds: timeout_seconds,
    sourceQuality: source_quality ? {
      profile: source_quality.profile, resolution: source_quality.resolution,
      fps: source_quality.fps, onUnavailable: source_quality.on_unavailable,
    } : undefined,
  }, undefined, extra.signal);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(research, null, 2) }],
    structuredContent: { ...research },
    isError: research.status === "unavailable",
  };
});

server.registerTool("analyze_long_video_url", {
  title: "Research a Long Video with Catalyst",
  description: "Research one selected video or Bilibili part with bounded overview and detail windows. Reports original source times, separate overview/detail coverage and unread intervals. Language uses captions or ASR; vision removes audio; multimodal includes explicit ASR. By default saves local research checkpoints for explicit resume or a separate follow-up question, without retaining media or credentials. Use save_session=false for a transient run. No background continuation. Comments are not collected.",
  inputSchema: {
    url: z.string().min(1).max(8192),
    question: z.string().min(3),
    mode: z.enum(["language", "vision", "multimodal"]),
    language: z.string().min(2).max(20).optional(),
    source_quality: sourceQualitySchema,
    start_seconds: z.number().min(0).optional().describe("Optional source interval; provide with end_seconds. Bilibili p selects one part, never the entire collection."),
    end_seconds: z.number().positive().optional(),
    segment_seconds: z.number().int().min(120).max(900).default(600),
    max_segments: z.number().int().min(1).max(24).default(12).describe("Preflight budget: an overview needing more segments is rejected before media acquisition. No silent sampling of only the beginning."),
    max_detail_windows: z.number().int().min(0).max(4).default(2),
    detail_window_seconds: z.number().int().min(30).max(300).default(120),
    max_download_mb: z.number().int().min(32).max(2048).default(512).describe("Cumulative retained acquired-file bytes, including repeated detail acquisitions. This is not a hard cap on network traffic."),
    window_timeout_seconds: z.number().int().min(15).max(600).default(180).describe("Deadline for one overview or detail window, within the shared request deadline. A stalled window fails independently so later windows can still run."),
    timeout_seconds: z.number().min(5).max(1800).default(900).describe("Shared deadline for all windows and synthesis. The host timeout must exceed this plus startup overhead. Completed segment reports survive cancellation or timeout."),
    save_session: z.boolean().default(true).describe("Save local reports, transcripts, references and progress after each window for explicit resume. Media, credentials and signed access URLs are not saved."),
  },
  outputSchema: longVideoResultShape,
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ url, question, mode, language, source_quality, start_seconds, end_seconds, segment_seconds, max_segments, max_detail_windows, detail_window_seconds, max_download_mb, window_timeout_seconds, timeout_seconds, save_session }, extra) => {
  try {
    const research = await startLongVideoResearch({
      url, question, mode, language, startSeconds: start_seconds, endSeconds: end_seconds,
      segmentSeconds: segment_seconds, maxSegments: max_segments, maxDetailWindows: max_detail_windows,
      detailWindowSeconds: detail_window_seconds, maxDownloadMB: max_download_mb, windowTimeoutSeconds: window_timeout_seconds, timeoutSeconds: timeout_seconds,
      sourceQuality: source_quality ? { profile: source_quality.profile, resolution: source_quality.resolution, fps: source_quality.fps, onUnavailable: source_quality.on_unavailable } : undefined,
    }, { signal: extra.signal, saveSession: save_session });
    return { content: [{ type: "text" as const, text: JSON.stringify(research, null, 2) }], structuredContent: { ...research }, isError: research.status === "unavailable" };
  } catch (error) { return sessionFailure(error); }
});

function sessionFailure(error: unknown) {
  const value = error as { code?: string; message?: string };
  const issue = { code: value.code ?? "SESSION_FAILED", message: value.message ?? "The session operation failed." };
  return { ...result(JSON.stringify({ error: issue })), isError: true };
}
const sessionIdSchema = z.string().uuid().describe("Local research session UUID returned by analyze_long_video_url or list_research_sessions.");
server.registerTool("follow_up_long_video_research", {
  title: "Ask a New Question About a Saved Video",
  description: "Create an independent saved question from a compatible long-video session. Reuses saved source captions or ASR, never the parent's reports, relevance or final answer. Recomputes relevance and focus for the new question. Language mode uses saved text only; multimodal locates detail windows from text and acquires only those clips for new visual analysis. Missing material remains explicit. The selected video, part, time range and language stay fixed; the parent record is unchanged. No cross-video search or background work.",
  inputSchema: z.strictObject({
    session_id: sessionIdSchema,
    question: z.string().trim().min(3).describe("A new research question about the same selected video and saved source interval."),
    mode: z.enum(["language", "multimodal"]).default("language").describe("language answers from saved captions/ASR only; multimodal additionally inspects newly selected detail clips. Transcripts do not establish visual evidence."),
    url: z.string().min(1).max(8192).optional().describe("Optional fresh source/share URL; it must resolve to the same video and selected part. Access parameters are not saved."),
    max_detail_windows: z.number().int().min(0).max(4).optional().describe("Language requires 0 (default). Multimodal requires 1 to 4 (default 2)."),
    detail_window_seconds: z.number().int().min(30).max(300).optional(),
    timeout_seconds: z.number().min(5).max(1800).optional(),
    window_timeout_seconds: z.number().int().min(15).max(600).optional(),
    max_download_mb: z.number().int().min(32).max(2048).optional(),
  }),
  outputSchema: longVideoResultShape,
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ session_id, question, mode, url, max_detail_windows, detail_window_seconds, timeout_seconds, window_timeout_seconds, max_download_mb }, extra) => {
  try {
    const research = await followUpLongVideoResearch(session_id, { question, mode, url, maxDetailWindows: max_detail_windows, detailWindowSeconds: detail_window_seconds,
      timeoutSeconds: timeout_seconds, windowTimeoutSeconds: window_timeout_seconds, maxDownloadMB: max_download_mb }, { signal: extra.signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(research, null, 2) }], structuredContent: { ...research }, isError: research.status === "unavailable" };
  } catch (error) { return sessionFailure(error); }
});
server.registerTool("resume_long_video_research", {
  title: "Resume a Saved Long-video Research Session",
  description: "Reload a local session, revalidate the selected source, and retry only unfinished overview/detail windows for the original question. Successful windows retain their source evidence IDs and incur no acquisition, transcription or segment-analysis calls; final synthesis is rebuilt. The original mode, language, quality and research plan stay fixed. Runtime budgets apply to this invocation. No automatic background work.",
  inputSchema: z.strictObject({
    session_id: sessionIdSchema,
    url: z.string().min(1).max(8192).optional().describe("Optional fresh original source/share URL when access parameters expired. It must resolve to the same video and selected part; access parameters are not persisted."),
    timeout_seconds: z.number().min(5).max(1800).optional(),
    window_timeout_seconds: z.number().int().min(15).max(600).optional(),
    max_download_mb: z.number().int().min(32).max(2048).optional(),
  }),
  outputSchema: longVideoResultShape,
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ session_id, url, timeout_seconds, window_timeout_seconds, max_download_mb }, extra) => {
  try {
    const research = await resumeLongVideoResearch(session_id, { url, timeoutSeconds: timeout_seconds, windowTimeoutSeconds: window_timeout_seconds, maxDownloadMB: max_download_mb }, { signal: extra.signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(research, null, 2) }], structuredContent: { ...research }, isError: research.status === "unavailable" };
  } catch (error) { return sessionFailure(error); }
});
server.registerTool("list_research_sessions", {
  title: "List Local Research Sessions", description: "List up to 100 saved local long-video research sessions, their questions and any follow-up parent revision, newest first. No source or provider calls.",
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => {
  try { const sessions = await new ResearchSessionStore().list(); return { ...result(JSON.stringify({ sessions }, null, 2)), structuredContent: { sessions } }; }
  catch (error) { return sessionFailure(error); }
});
server.registerTool("get_research_session", {
  title: "Read a Local Research Session", description: "Read the last durable research result, its coverage and session revision without source or provider calls.",
  inputSchema: { session_id: sessionIdSchema }, outputSchema: longVideoResultShape, annotations: { readOnlyHint: true },
}, async ({ session_id }) => {
  try { const research = sanitizeSessionResult((await new ResearchSessionStore().load(session_id)).result); return { ...result(JSON.stringify(research, null, 2)), structuredContent: { ...research } }; }
  catch (error) { return sessionFailure(error); }
});
server.registerTool("delete_research_session", {
  title: "Delete a Local Research Session", description: "Delete one local saved result. Refuses while that session is running. No remote content is changed.",
  inputSchema: { session_id: sessionIdSchema }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}, async ({ session_id }) => {
  try { await new ResearchSessionStore().delete(session_id); return { ...result(JSON.stringify({ session_id, deleted: true })), structuredContent: { session_id, deleted: true } }; }
  catch (error) { return sessionFailure(error); }
});

server.registerTool("analyze_xiaohongshu_note", {
  title: "Research a Xiaohongshu Note",
  description: "Research Xiaohongshu image/text notes first, automatically routing confirmed video notes to the existing video workflow. Accepts original links or copied share text. The default text mode reads the note body and OCR of all selected image pages; vision reads pictures and diagrams; combined uses both. Citations use 1-based original image page numbers, never invented timestamps. Local Apple Vision OCR is preferred when available, with configured-provider OCR fallback. Comments are unsupported. Long notes can be selected by page range; no pages are silently skipped. Model observations and OCR remain unverified.",
  inputSchema: {
    url: z.string().min(1).max(8192).describe("Original Xiaohongshu note/short URL or share text containing one link; retain original share query parameters."),
    question: z.string().min(3),
    mode: z.enum(["text", "vision", "combined"]).default("text"),
    language: z.string().min(2).max(20).optional(),
    start_page: z.number().int().positive().optional().describe("1-based original image start page; provide with end_page. Only this range is researched."),
    end_page: z.number().int().positive().optional().describe("Original image end page, inclusive. At most 50 images per request."),
    timeout_seconds: z.number().min(5).max(600).default(300),
  },
  outputSchema: xiaohongshuResearchResultShape,
  annotations: { readOnlyHint: true },
}, async ({ url, question, mode, language, start_page, end_page, timeout_seconds }, extra) => {
  const research = await researchXiaohongshuNote({ url, question, mode, language, startPage: start_page, endPage: end_page, timeoutSeconds: timeout_seconds }, undefined, extra.signal);
  return { content: [{ type: "text" as const, text: JSON.stringify(research, null, 2) }], structuredContent: { ...research }, isError: research.status === "unavailable" };
});

await server.connect(new StdioServerTransport());
