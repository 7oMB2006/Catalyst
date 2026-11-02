import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionContext, MediaAsset, Platform, ResearchRequest, VideoIdentity } from "./contracts.js";
import { assessDownloadedQuality, parseYtDlpMetadata, resolveSourceQuality, selectYtDlpFormat, type YtDlpMetadata } from "./media-quality.js";
import { getFfmpegPath } from "./video-analysis.js";
import { runProcess } from "./process.js";

const require = createRequire(import.meta.url);

export class AcquisitionError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message);
    this.name = "AcquisitionError";
  }
}

export function inspectDownloader(env: NodeJS.ProcessEnv = process.env): { command: string; prefixArgs: string[]; source: "override" | "bundled" | "path" } {
  const override = env.YTDLP_PATH?.trim();
  let downloader = override;
  if (!downloader) {
    try { downloader = path.resolve(path.dirname(require.resolve("yt-dlp-exec")), "..", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"); }
    catch { /* An external yt-dlp installation can replace the optional package. */ }
  }
  if (!downloader) return { command: env.YTDLP_PYTHON?.trim() || "yt-dlp", prefixArgs: env.YTDLP_PYTHON?.trim() ? ["-m", "yt_dlp"] : [], source: "path" };
  return { command: env.YTDLP_PYTHON?.trim() || downloader, prefixArgs: env.YTDLP_PYTHON?.trim() ? [downloader] : [], source: override ? "override" : "bundled" };
}

export function safeDiagnostic(value: string): string {
  let text = value.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}${url.search ? "?[query omitted]" : ""}`; }
    catch { return "[URL omitted]"; }
  }).replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[credential omitted]")
    .replace(/(?:SESSDATA|bili_jct|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "[credential omitted]");
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && secret && secret.length >= 8) text = text.split(secret).join("[credential omitted]");
  }
  return text.slice(-1500);
}

export function remainingTime(context: ExecutionContext): number {
  context.signal.throwIfAborted();
  const remaining = context.deadlineMs - Date.now();
  if (remaining <= 0) throw new AcquisitionError("TIMEOUT", "The acquisition deadline expired.", true);
  return Math.min(remaining, 2_147_483_647);
}

export async function credentialArgs(platform: Platform): Promise<string[]> {
  const prefix = platform === "bilibili" ? "BILIBILI" : "YOUTUBE";
  const cookieFile = process.env[`${prefix}_COOKIES_FILE`]?.trim();
  if (cookieFile) {
    const stat = await fs.stat(cookieFile).catch(() => undefined);
    if (!stat?.isFile()) throw new AcquisitionError("CONFIGURATION", `${prefix}_COOKIES_FILE must name an existing Netscape cookie file.`);
    return ["--cookies", path.resolve(cookieFile)];
  }
  const browser = process.env[`${prefix}_COOKIES_FROM_BROWSER`]?.trim().toLowerCase();
  if (!browser) return [];
  if (!["chrome", "edge", "firefox", "brave", "chromium", "safari", "opera", "vivaldi"].includes(browser)) {
    throw new AcquisitionError("CONFIGURATION", `${prefix}_COOKIES_FROM_BROWSER names an unsupported browser.`);
  }
  return ["--cookies-from-browser", browser];
}

function acquisitionFailure(error: unknown, context: ExecutionContext): Error {
  if (context.signal.aborted) return new AcquisitionError("TIMEOUT", "Acquisition was cancelled or its deadline expired.", true);
  if (error instanceof AcquisitionError) return error;
  const detail = error as { code?: string; stderr?: string; message?: string };
  if (detail.code === "ENOENT") return new AcquisitionError("DEPENDENCY_MISSING", "The configured downloader or Python executable could not be started.");
  if (detail.code === "MAX_BUFFER") return new AcquisitionError("RESOURCE_LIMIT", "The downloader exceeded its output size limit; its subprocess tree was terminated.");
  const message = safeDiagnostic(detail.stderr || detail.message || String(error));
  if (/cookies|sign in|log in|login|not a bot/i.test(message)) return new AcquisitionError("AUTH_REQUIRED", `Source access requires an explicitly configured authorized session. ${message}`);
  if (/HTTP Error (?:403|412)|HTTP (?:403|412)/i.test(message)) return new AcquisitionError("ACCESS_BLOCKED", `The platform rejected source access. ${message}`);
  if (/timeout|timed out|ETIMEDOUT|SIGTERM|aborted/i.test(message)) return new AcquisitionError("TIMEOUT", "Source acquisition timed out.", true);
  return new AcquisitionError("ACQUISITION_FAILED", message || "Source acquisition failed.", true);
}

export async function runYtDlp(args: string[], platform: Platform, context: ExecutionContext): Promise<{ stdout: string; stderr: string }> {
  const runtime = inspectDownloader();
  const auth = await credentialArgs(platform);
  const common = ["--ignore-config", "--no-cache-dir", "--no-playlist", "--no-warnings", "--socket-timeout", "15", "--retries", "1", "--extractor-retries", "1"];
  if (platform === "youtube") common.push("--js-runtimes", `node:${process.execPath}`);
  try {
    return await runProcess(runtime.command, [...runtime.prefixArgs, ...common, ...auth, ...args], {
      timeout: remainingTime(context), signal: context.signal, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) { throw acquisitionFailure(error, context); }
}

export async function probeMedia(url: string, platform: Platform, context: ExecutionContext): Promise<Record<string, unknown> & YtDlpMetadata> {
  const { stdout } = await runYtDlp(["--skip-download", "--dump-single-json", "--", url], platform, context);
  return parseYtDlpMetadata(stdout) as Record<string, unknown> & YtDlpMetadata;
}

export async function downloadMedia(video: VideoIdentity, request: ResearchRequest, context: ExecutionContext): Promise<MediaAsset> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-source-"));
  try {
    const available = await probeMedia(video.canonicalUrl, video.platform, context);
    const quality = request.sourceQuality ? resolveSourceQuality(request.sourceQuality) : undefined;
    const selection = quality ? selectYtDlpFormat(available, quality) : undefined;
    const selector = selection?.selector ?? (request.mode === "language"
      ? "bestaudio/best"
      : "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b");
    const configuredLimit = Number(process.env.CATALYST_MAX_MEDIA_MB ?? 256);
    if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) throw new AcquisitionError("CONFIGURATION", "CATALYST_MAX_MEDIA_MB must be a positive number.");
    const { stdout } = await runYtDlp([
      "--no-continue", "--restrict-filenames", "--no-progress", "--max-filesize", `${configuredLimit}M`,
      "--ffmpeg-location", getFfmpegPath(), "--merge-output-format", "mp4", "--print-json",
      "-f", selector, "-o", path.join(directory, "source.%(ext)s"), "--", video.canonicalUrl,
    ], video.platform, context);
    const files = await fs.readdir(directory);
    const filename = files.find((name) => /^source\.(?:mp4|mkv|webm|mov|m4a|mp3|wav|ogg|aac)$/i.test(name));
    if (!filename) throw new AcquisitionError("MEDIA_UNAVAILABLE", "The downloader did not produce media within the configured size and format limits.");
    const mediaPath = path.join(directory, filename);
    const stat = await fs.stat(mediaPath);
    if (stat.size > configuredLimit * 1024 * 1024) throw new AcquisitionError("RESOURCE_LIMIT", "The acquired media exceeds CATALYST_MAX_MEDIA_MB.");
    try {
      await runProcess(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-i", mediaPath, "-t", "1", "-f", "null", "-"], { timeout: remainingTime(context), signal: context.signal, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch (error) { throw acquisitionFailure(error, context); }
    const metadata = parseYtDlpMetadata(stdout);
    const selected = metadata.requested_formats?.find((format) => format.vcodec && format.vcodec !== "none") ?? metadata;
    const report = quality && selection ? assessDownloadedQuality(metadata, quality, selection) : undefined;
    if (report?.status === "degraded" && quality?.onUnavailable === "error") throw new AcquisitionError("QUALITY_UNAVAILABLE", "Downloaded media is below the requested source quality.");
    return {
      path: mediaPath, width: selected.width, height: selected.height, fps: selected.fps,
      formatId: String(metadata.format_id ?? selection?.formatId ?? selector), bytes: stat.size, quality: report,
      dispose: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
