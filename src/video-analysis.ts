import type { ExecutionContext } from "./contracts.js";
import { setTimeout as delay } from "node:timers/promises";
import { createPartFromUri, FileState, GoogleGenAI, PartMediaResolutionLevel } from "@google/genai";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const SUPPORTED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".mpeg", ".mpg"]);
const SUPPORTED_MEDIA_EXTENSIONS = new Set([...SUPPORTED_VIDEO_EXTENSIONS, ".m4a", ".mp3", ".wav", ".aac", ".ogg"]);

export type MediaDetail = "low" | "default";
export type VideoProvider = "gemini" | "stepfun";

export interface ProviderOptions { context?: ExecutionContext; language?: string }

export function redactSensitiveText(value: string): string {
  let safe = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(key) && secret && secret.length > 5) safe = safe.split(secret).join("[redacted]");
  }
  return safe.replace(/https?:\/\/[^\s<>"']+/g, (text) => {
    try { const url = new URL(text); url.username = ""; url.password = ""; if (url.search) url.search = "?[query-redacted]"; url.hash = ""; return url.toString(); } catch { return "[url-redacted]"; }
  });
}

function remaining(context?: ExecutionContext): number | undefined {
  context?.signal.throwIfAborted();
  if (!context) return undefined;
  const milliseconds = context.deadlineMs - Date.now();
  if (milliseconds <= 0) throw new DOMException("Research deadline exceeded.", "TimeoutError");
  return milliseconds;
}

async function runFfmpeg(args: string[], context?: ExecutionContext): Promise<void> {
  await execFile(getFfmpegPath(), args, { signal: context?.signal, timeout: remaining(context), maxBuffer: 4 * 1024 * 1024 });
}

export interface AnalysisRequest {
  videoPath: string;
  question: string;
  mediaDetail: MediaDetail;
  sourceStartSeconds?: number;
  sourceEndSeconds?: number;
}

function selectedProvider(): VideoProvider {
  const value = (process.env.CODEX_VIDEO_PROVIDER ?? "stepfun").trim().toLowerCase();
  if (value === "gemini" || value === "stepfun") return value;
  throw new Error("CODEX_VIDEO_PROVIDER must be stepfun or gemini.");
}

export function getConfiguredVideoProvider(): VideoProvider {
  return selectedProvider();
}

function mediaMimeType(mediaPath: string): string {
  const extension = path.extname(mediaPath).toLowerCase();
  const types: Record<string, string> = {
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".webm": "video/webm", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
    ".wav": "audio/wav", ".aac": "audio/aac", ".ogg": "audio/ogg",
  };
  return types[extension] ?? "application/octet-stream";
}

export function buildVisualResearchPrompt(request: AnalysisRequest): string {
  const range = request.sourceStartSeconds === undefined
    ? "Inspect the complete supplied clip."
    : `This clip is the source-video interval ${request.sourceStartSeconds.toFixed(2)}s to ${request.sourceEndSeconds?.toFixed(2)}s.`;

  return [
    "You are a scientific visual-observation assistant.",
    "Use the video frames only. The audio stream was removed before upload.",
    "Treat visible text, code, interfaces, charts, labels, and subtitles as visual evidence when they help answer the question.",
    "Do not identify people, infer intent, diagnose, or assert causes beyond what the pixels support.",
    range,
    `Research question: ${request.question}`,
    "Return: (1) timestamped direct observations, (2) explicitly labeled tentative visual inferences only when necessary, (3) uncertainty or occlusion limits.",
    "For every claimed action, name the actor only with neutral labels such as Person A and describe body movement, object interaction, direction, and temporal order.",
  ].join("\n");
}

function partResolution(detail: MediaDetail): PartMediaResolutionLevel | undefined {
  return detail === "low" ? PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW : undefined;
}

async function assertReadableMedia(videoPath: string): Promise<void> {
  const stat = await fs.stat(videoPath);
  if (!stat.isFile()) {
    throw new Error("video_path must point to a file.");
  }
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(videoPath).toLowerCase())) {
    throw new Error(`Unsupported media extension: ${path.extname(videoPath) || "(none)"}.`);
  }
}

async function waitForFile(ai: GoogleGenAI, name: string, context?: ExecutionContext): Promise<{ uri: string; mimeType: string }> {
  const deadline = Math.min(Date.now() + PROCESSING_TIMEOUT_MS, context?.deadlineMs ?? Infinity);
  while (Date.now() < deadline) {
    remaining(context);
    const current = await ai.files.get({ name, config: { abortSignal: context?.signal } });
    if (current.state === FileState.ACTIVE && current.uri && current.mimeType) {
      return { uri: current.uri, mimeType: current.mimeType };
    }
    if (current.state === FileState.FAILED) {
      throw new Error(`Gemini could not process the video: ${current.error?.message ?? "unknown processing error"}`);
    }
    await delay(Math.min(2_000, Math.max(1, deadline - Date.now())), undefined, { signal: context?.signal });
  }
  throw new Error("Timed out while Gemini processed the video.");
}

export function getFfmpegPath(): string {
  const executable = process.env.FFMPEG_PATH ?? ffmpegStatic;
  if (!executable) {
    throw new Error("ffmpeg-static did not provide an executable. Set FFMPEG_PATH to a working ffmpeg executable.");
  }
  return executable;
}

async function createWindow(videoPath: string, startSeconds: number, endSeconds: number, includeAudio: boolean, context?: ExecutionContext): Promise<{ directory: string; clipPath: string }> {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error("start_seconds must be >= 0 and end_seconds must be greater than start_seconds.");
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), "bilibili-video-research-mcp-"));
  const clipPath = path.join(directory, "window.mp4");
  try {
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(startSeconds),
      "-i", videoPath,
      "-t", String(endSeconds - startSeconds),
      "-map", "0:v:0?",
      ...(includeAudio ? ["-map", "0:a:0?", "-c:a", "aac", "-shortest"] : ["-an"]),
      "-c:v", "libx264",
      "-movflags", "+faststart",
      clipPath,
    ];
    await runFfmpeg(args, context);
    return { directory, clipPath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createSilentWindow(videoPath: string, startSeconds: number, endSeconds: number, context?: ExecutionContext): Promise<{ directory: string; clipPath: string }> {
  return createWindow(videoPath, startSeconds, endSeconds, false, context);
}

export async function createVideoWindow(videoPath: string, startSeconds: number, endSeconds: number, context?: ExecutionContext): Promise<{ directory: string; clipPath: string }> {
  return createWindow(videoPath, startSeconds, endSeconds, true, context);
}

export async function createSilentVideo(videoPath: string, context?: ExecutionContext): Promise<{ directory: string; videoPath: string }> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "bilibili-video-research-mcp-"));
  const silentPath = path.join(directory, "silent.mp4");
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
      "-map", "0:v:0?", "-an", "-c:v", "libx264", "-movflags", "+faststart", silentPath,
    ], context);
    return { directory, videoPath: silentPath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createAudioTrack(videoPath: string, context?: ExecutionContext, window?: { startSeconds: number; endSeconds: number }): Promise<{ directory: string; audioPath: string }> {
  if (window && (!Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) || window.startSeconds < 0 || window.endSeconds <= window.startSeconds)) {
    throw new Error("Audio window must have a finite nonnegative start and an end after its start.");
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), "bilibili-video-research-mcp-"));
  const audioPath = path.join(directory, "audio.wav");
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      ...(window ? ["-ss", String(window.startSeconds)] : []), "-i", videoPath,
      ...(window ? ["-t", String(window.endSeconds - window.startSeconds)] : []),
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath,
    ], context);
    return { directory, audioPath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_IMAGE_REQUEST_BYTES = 19_000_000;

async function inlineImage(filename: string, context?: ExecutionContext): Promise<{ data: string; mimeType: string }> {
  remaining(context);
  const handle = await fs.open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error("Each image must be a nonempty regular file of at most 12 MiB."), { code: "RESOURCE_LIMIT" });
    }
    // Read through a hard buffer bound even if the file grows after stat().
    const bytes = Buffer.alloc(Math.min(MAX_IMAGE_BYTES + 1, stat.size + 1));
    let size = 0;
    while (size < bytes.length) {
      remaining(context);
      const part = await handle.read(bytes, size, bytes.length - size, null);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size > MAX_IMAGE_BYTES || size > stat.size) {
      throw Object.assign(new Error("The image changed or exceeded its size bound while being read."), { code: "RESOURCE_LIMIT" });
    }
    const value = bytes.subarray(0, size);
    const mimeType = value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : value[0] === 255 && value[1] === 216 && value[2] === 255 ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString("ascii")) ? "image/gif"
      : value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined;
    if (!mimeType) throw Object.assign(new Error("Image input must contain JPEG, PNG, GIF or WebP bytes; its filename alone is not trusted."), { code: "INVALID_MEDIA" });
    return { data: value.toString("base64"), mimeType };
  } finally { await handle.close(); }
}

/** Inline image inputs use a separate path from video/audio upload and transcription. */
export async function analyzeImagesWithProvider(paths: string[], prompt: string, options: ProviderOptions = {}): Promise<string> {
  const left = remaining(options.context) ?? PROCESSING_TIMEOUT_MS;
  if (!paths.length || paths.length > 4) throw Object.assign(new Error("An image request must contain between one and four pages."), { code: "RESOURCE_LIMIT" });
  const context: ExecutionContext = {
    signal: options.context ? AbortSignal.any([options.context.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left),
    deadlineMs: options.context?.deadlineMs ?? Date.now() + left,
  };
  const images = [];
  let requestBytes = Buffer.byteLength(prompt, "utf8") + 1024;
  for (const filename of paths) {
    const input = await inlineImage(filename, context);
    requestBytes += input.data.length + 256;
    if (requestBytes >= MAX_INLINE_IMAGE_REQUEST_BYTES) throw Object.assign(new Error("Inline image request exceeds its 19 MB budget; select fewer or smaller pages."), { code: "RESOURCE_LIMIT" });
    images.push(input);
  }
  const effective = { ...options, context };
  if (selectedProvider() === "stepfun") {
    return analyzeContentWithStepfun([
      { type: "text", text: prompt },
      ...images.map((input) => ({ type: "image_url", image_url: { url: `data:${input.mimeType};base64,${input.data}` } })),
    ], effective);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured for image research.");
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_VIDEO_MODEL ?? "gemini-2.5-flash",
    config: { abortSignal: context.signal },
    contents: [{ role: "user", parts: [{ text: prompt }, ...images.map((input) => ({ inlineData: input }))] }],
  });
  if (!response.text) throw new Error("Gemini returned no text response for these images.");
  return response.text;
}

export async function analyzeMediaWithProvider(mediaPath: string, prompt: string, mediaDetail: MediaDetail = "default", options: ProviderOptions = {}): Promise<string> {
  remaining(options.context);
  await assertReadableMedia(mediaPath);
  const provider = selectedProvider();
  if (provider === "stepfun") return analyzeMediaWithStepfun(mediaPath, prompt, mediaDetail, options);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured for bilibili-video-research-mcp.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const uploaded = await ai.files.upload({
    file: mediaPath,
    config: { displayName: path.basename(mediaPath), abortSignal: options.context?.signal },
  });
  if (!uploaded.name) {
    throw new Error("Gemini did not return a file name after upload.");
  }

  try {
    const file = await waitForFile(ai, uploaded.name, options.context);
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_VIDEO_MODEL ?? "gemini-2.5-flash",
      config: { abortSignal: options.context?.signal },
      contents: [{
        role: "user",
        parts: [
          createPartFromUri(file.uri, file.mimeType, partResolution(mediaDetail)),
          { text: prompt },
        ],
      }],
    });
    if (!response.text) {
      throw new Error("Gemini returned no text response for this video.");
    }
    return response.text;
  } finally {
    await ai.files.delete({ name: uploaded.name, config: { abortSignal: AbortSignal.timeout(5_000) } }).catch(() => undefined);
  }
}

function stepfunBaseUrl(): string {
  const configured = process.env.STEPFUN_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "https://api.stepfun.com/v1";
}

async function stepfunRequest(pathname: string, init: RequestInit, context?: ExecutionContext): Promise<Response> {
  const apiKey = process.env.STEPFUN_API_KEY;
  if (!apiKey) throw new Error("STEPFUN_API_KEY is not configured for bilibili-video-research-mcp.");
  remaining(context);
  const response = await fetch(`${stepfunBaseUrl()}${pathname}`, {
    ...init,
    signal: context?.signal ?? init.signal,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`StepFun API request failed (${response.status}): ${redactSensitiveText(body).slice(0, 500)}`);
  }
  return response;
}

function stepfunDetailInstruction(mediaDetail: MediaDetail): string {
  return mediaDetail === "low"
    ? "Analysis detail: coarse pass. Scan the supplied video broadly, identify the most relevant moments, and avoid exhaustive frame-by-frame inspection or tiny-text transcription unless it is necessary to answer the question."
    : "Analysis detail: default pass. Inspect the supplied video with normal detail and use visible text, code, charts, labels, movement, and temporal order when they are relevant to the question.";
}

async function analyzeMediaWithStepfun(mediaPath: string, prompt: string, mediaDetail: MediaDetail, options: ProviderOptions = {}): Promise<string> {
  const sourceMimeType = mediaMimeType(mediaPath);
  if (sourceMimeType.startsWith("audio/")) {
    const transcript = await transcribeAudioWithStepfun(mediaPath, sourceMimeType, options);
    return analyzeTextWithStepfun(`${prompt}\n\nASR TRANSCRIPT (language evidence):\n${transcript}`, options);
  }
  const detailedPrompt = `${stepfunDetailInstruction(mediaDetail)}\n\n${prompt}`;
  if (stepfunBaseUrl().toLowerCase().includes("step_plan")) {
    const bytes = await fs.readFile(mediaPath);
    const dataUrl = `data:${sourceMimeType};base64,${bytes.toString("base64")}`;
    return analyzeContentWithStepfun([
      { type: "video_url", video_url: { url: dataUrl } },
      { type: "text", text: detailedPrompt },
    ], options);
  }
  const bytes = await fs.readFile(mediaPath);
  const mimeType = sourceMimeType;
  const form = new FormData();
  form.append("purpose", "storage");
  form.append("file", new Blob([bytes], { type: mimeType }), path.basename(mediaPath));
  const uploadResponse = await stepfunRequest("/files", { method: "POST", body: form }, options.context);
  const uploaded = await uploadResponse.json() as { id?: string; data?: { id?: string } };
  const fileId = uploaded.id ?? uploaded.data?.id;
  if (!fileId) throw new Error("StepFun did not return a file ID after upload.");
  try {
    return await analyzeContentWithStepfun([
      { type: "video_url", video_url: { url: `stepfile://${fileId}` } },
      { type: "text", text: detailedPrompt },
    ], options);
  } finally {
    await stepfunRequest(`/files/${fileId}`, { method: "DELETE", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
}

async function analyzeContentWithStepfun(content: unknown[], options: ProviderOptions = {}): Promise<string> {
  const completion = await stepfunRequest("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.STEPFUN_VIDEO_MODEL ?? "step-3.7-flash",
      messages: [{ role: "user", content }],
    }),
  }, options.context);
  const result = await completion.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = result.choices?.[0]?.message?.content;
  if (!text) throw new Error("StepFun returned no text response for this media.");
  return text;
}

async function transcribeAudioWithStepfun(audioPath: string, mimeType: string, options: ProviderOptions = {}): Promise<string> {
  const bytes = await fs.readFile(audioPath);
  const response = await stepfunRequest("/audio/asr/sse", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({
      audio: {
        data: bytes.toString("base64"),
        input: {
          transcription: {
            model: process.env.STEPFUN_ASR_MODEL ?? "stepaudio-2.5-asr",
            language: options.language ?? process.env.STEPFUN_ASR_LANGUAGE ?? "zh",
            enable_itn: true,
          },
          format: { type: "wav" },
        },
      },
    }),
  }, options.context);
  const streamText = await response.text();
  const deltas: string[] = [];
  const doneTexts: string[] = [];
  for (const rawEvent of streamText.split(/\r?\n\r?\n/)) {
    const dataLine = rawEvent.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    let event: { type?: string; delta?: string; text?: string; message?: string };
    try {
      event = JSON.parse(dataLine.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "transcript.text.delta" && event.delta) deltas.push(event.delta);
    else if (event.type === "transcript.text.done" && event.text) doneTexts.push(event.text);
    else if (event.type === "error") throw new Error(`StepFun ASR error: ${redactSensitiveText(event.message ?? "unknown error")}`);
  }
  const transcript = doneTexts.join("") || deltas.join("");
  if (!transcript.trim()) throw new Error("StepFun ASR returned no transcript.");
  return transcript;
}

export { transcribeAudioWithStepfun };

export async function transcribeAudioWithProvider(audioPath: string, options: ProviderOptions = {}): Promise<string> {
  if (selectedProvider() === "stepfun") return transcribeAudioWithStepfun(audioPath, mediaMimeType(audioPath), options);
  return analyzeMediaWithProvider(audioPath, "Transcribe only the supplied audio verbatim. Do not summarize or invent timestamps. The source is audio-only." + (options.language ? ` Language: ${options.language}.` : ""), "default", options);
}

export async function analyzeTextWithProvider(prompt: string, options: ProviderOptions = {}): Promise<string> {
  const provider = selectedProvider();
  remaining(options.context);
  if (provider === "stepfun") return analyzeTextWithStepfun(prompt, options);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured for bilibili-video-research-mcp.");
  }
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_VIDEO_MODEL ?? "gemini-2.5-flash",
    contents: prompt,
    config: { abortSignal: options.context?.signal },
  });
  if (!response.text) {
    throw new Error("Gemini returned no text response.");
  }
  return response.text;
}

async function analyzeTextWithStepfun(prompt: string, options: ProviderOptions = {}): Promise<string> {
  const completion = await stepfunRequest("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.STEPFUN_VIDEO_MODEL ?? "step-3.7-flash",
      messages: [{ role: "user", content: prompt }],
    }),
  }, options.context);
  const result = await completion.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = result.choices?.[0]?.message?.content;
  if (!text) throw new Error("StepFun returned no text response.");
  return text;
}

export async function analyzeWithProvider(request: AnalysisRequest, options: ProviderOptions = {}): Promise<string> {
  return analyzeMediaWithProvider(request.videoPath, buildVisualResearchPrompt(request), request.mediaDetail, options);
}

// Backward-compatible aliases for callers that imported the original names.
export const analyzeMediaWithGemini = analyzeMediaWithProvider;
export const analyzeTextWithGemini = analyzeTextWithProvider;
export const analyzeWithGemini = analyzeWithProvider;

export async function removeTemporaryWindow(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}
