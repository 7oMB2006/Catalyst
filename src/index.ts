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
import { researchResultShape } from "./result-schema.js";

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
