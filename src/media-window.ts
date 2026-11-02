import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { getCACertificates } from "node:tls";
import { AcquisitionError, probeMedia, remainingTime, runYtDlp } from "./acquisition.js";
import type { ExecutionContext, MediaAsset, ResearchMode, ResearchRequest, VideoIdentity } from "./contracts.js";
import { assessDownloadedQuality, parseYtDlpMetadata, resolveSourceQuality, selectYtDlpFormat, type YtDlpFormat, type YtDlpMetadata } from "./media-quality.js";
import { runProcess } from "./process.js";
import { getFfmpegPath, type MediaDetail } from "./video-analysis.js";

const MIB = 1024 * 1024;
const MAX_PREPARED_BYTES = 32 * MIB;
const MEDIA_FILE = /^window\.(?:mp4|mkv|webm|mov|m4a|mp3|wav|ogg|aac)$/i;
const CA_FILE = "trusted-ca.pem";

function mediaByteLimit(): number {
  const megabytes = Number(process.env.CATALYST_MAX_MEDIA_MB ?? 256);
  if (!Number.isFinite(megabytes) || megabytes <= 0 || !Number.isSafeInteger(Math.floor(megabytes * MIB))) {
    throw new AcquisitionError("CONFIGURATION", "CATALYST_MAX_MEDIA_MB must be a finite positive media size.");
  }
  return Math.floor(megabytes * MIB);
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    // The bounded public CA bundle is configuration, not downloaded media.
    if (!entry.isFile() || entry.name === CA_FILE) continue;
    const stat = await fs.stat(path.join(directory, entry.name)).catch(() => undefined);
    total += stat?.size ?? 0;
  }
  return total;
}

/** yt-dlp parses downloader argument strings with Python shlex, including on Windows. */
function downloaderArgument(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

async function writeTrustedCaBundle(directory: string): Promise<string> {
  // Use the Node process's effective default trust configuration: bundled roots,
  // extra startup CAs, and system roots only when Node was configured to use them.
  const certificates = getCACertificates("default");
  if (!certificates.length) throw new AcquisitionError("CONFIGURATION", "No trusted CA certificates are configured for verified media acquisition.");
  const bundle = path.join(directory, CA_FILE);
  await fs.writeFile(bundle, certificates.join("\n") + "\n", { mode: 0o600 });
  return bundle;
}

function defaultWindowSelector(available: YtDlpMetadata, request: ResearchRequest): string {
  if (request.mode === "language") return "bestaudio/best";
  const sourceHeight = request.mediaDetail === "low" ? 480 : 720;
  const preferred = request.mode === "vision" ? `bv*[height<=${sourceHeight}][ext=mp4]/bv*[height<=${sourceHeight}]`
    : `bv*[height<=${sourceHeight}][ext=mp4]+ba[ext=m4a]/b[height<=${sourceHeight}][ext=mp4]/bv*[height<=${sourceHeight}]+ba/b[height<=${sourceHeight}]`;
  type Format = YtDlpFormat & { ext?: string; protocol?: string };
  const formats = (available.formats ?? []) as Format[];
  const id = (format: Format) => format.format_id === undefined || format.format_id === null ? undefined : String(format.format_id);
  const hasAudio = (format: Format) => Boolean(format.acodec && format.acodec !== "none" && format.acodec !== "unknown");
  const audio = formats.filter((format) => id(format) && format.vcodec === "none" && hasAudio(format))
    .sort((left, right) => Number(right.abr ?? right.tbr ?? 0) - Number(left.abr ?? left.tbr ?? 0))[0];
  const videos = formats.filter((format) => id(format) && Number.isFinite(format.height) && Number(format.height) > 0
    && format.vcodec !== "none" && format.protocol !== "mhtml" && !["mhtml", "jpg", "jpeg", "png", "webp", "gif", "avif"].includes(format.ext ?? "")
    && (request.mode === "vision" || hasAudio(format) || audio || format.acodec === undefined));
  if (videos.some((format) => Number(format.height) <= sourceHeight)) return preferred;
  // A platform may expose only one 720p/1080p stream. Choose the smallest real
  // video advertised by the probe rather than failing the optional preference.
  // Directory, per-window upload, deadline, and caller byte limits still apply.
  const smallest = videos.sort((left, right) => Number(left.height) - Number(right.height)
    || Number(left.fps ?? 0) - Number(right.fps ?? 0) || Number(left.tbr ?? 0) - Number(right.tbr ?? 0))[0];
  if (!smallest) return preferred;
  const fallback = `${id(smallest)}${request.mode === "multimodal" && !hasAudio(smallest) && audio ? `+${id(audio)}` : ""}`;
  return `${preferred}/${fallback}`;
}

function advertisedSelectedStreams(available: YtDlpMetadata, downloaded: YtDlpMetadata): { audio: boolean; video: boolean } {
  const selectedIds = String(downloaded.format_id ?? "").split("+");
  const selected = [downloaded, ...(downloaded.requested_formats ?? []), ...(available.formats ?? []).filter((format) =>
    format.format_id !== undefined && selectedIds.includes(String(format.format_id)))];
  return {
    audio: selected.some((format) => Boolean(format.acodec && format.acodec !== "none" && format.acodec !== "unknown")),
    video: selected.some((format) => format.vcodec !== "none" && format.vcodec !== "unknown" && format.vcodec !== "images"
      && (Boolean(format.vcodec) || (Number.isFinite(format.height) && Number(format.height) > 0))),
  };
}

/** Stop growing FFmpeg/download output even when a remote server omits its length. */
async function guardedDownload<T>(directory: string, limit: number, context: ExecutionContext, action: (guarded: ExecutionContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const check = async () => {
    if (await directoryBytes(directory) > limit) controller.abort(new AcquisitionError("RESOURCE_LIMIT", "Window acquisition exceeded the configured temporary media size."));
  };
  const timer = setInterval(() => {
    if (!pending) pending = check().catch(() => undefined).finally(() => { pending = undefined; });
  }, 200);
  try {
    const result = await action({ ...context, signal: AbortSignal.any([context.signal, controller.signal]) });
    await check();
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearInterval(timer);
    await pending;
  }
}

interface MediaProbe { duration: number; width?: number; height?: number; fps?: number; hasAudio: boolean; hasVideo: boolean }

// ffmpeg-static is available on all supported CI platforms; ffprobe is not a dependency.
async function probeWindow(mediaPath: string, context: ExecutionContext): Promise<MediaProbe> {
  let diagnostic: string;
  try {
    const result = await runProcess(getFfmpegPath(), [
      "-hide_banner", "-nostdin", "-i", mediaPath, "-t", "1", "-f", "null", "-",
    ], { timeout: remainingTime(context), signal: context.signal, maxBuffer: MIB });
    diagnostic = result.stderr;
  } catch (error) {
    context.signal.throwIfAborted();
    if ((error as { code?: string }).code === "ENOENT") throw new AcquisitionError("DEPENDENCY_MISSING", "The configured FFmpeg executable could not be started.");
    throw new AcquisitionError("MEDIA_VALIDATION_FAILED", "The acquired window could not be decoded by FFmpeg.");
  }
  const time = diagnostic.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!time) throw new AcquisitionError("MEDIA_VALIDATION_FAILED", "The acquired window has no verifiable duration.");
  const video = diagnostic.split(/\r?\n/).find((line) => /Stream .*Video:/.test(line));
  const dimensions = video?.match(/\b(\d{2,6})x(\d{2,6})\b/);
  const rate = video?.match(/\b([\d.]+) fps\b/);
  return {
    duration: Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]),
    ...(dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : {}),
    ...(rate ? { fps: Number(rate[1]) } : {}), hasVideo: Boolean(video), hasAudio: /Stream .*Audio:/.test(diagnostic),
  };
}

/** Fetch a bounded source interval. There is deliberately no whole-source fallback. */
export async function acquireMediaWindow(video: VideoIdentity, request: ResearchRequest & { maxAcquiredBytes?: number }, context: ExecutionContext): Promise<MediaAsset> {
  remainingTime(context);
  const start = request.startSeconds, end = request.endSeconds;
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0 || start < 0 || end <= start || end > video.durationSeconds || end - start > 900) {
    throw new AcquisitionError("INVALID_WINDOW", "Window acquisition needs paired source times within the source duration, spanning at most 900 seconds.");
  }
  if (request.maxAcquiredBytes !== undefined && (!Number.isSafeInteger(request.maxAcquiredBytes) || request.maxAcquiredBytes <= 0)) {
    throw new AcquisitionError("RESOURCE_LIMIT", "No valid remaining acquisition byte budget is available for this window.");
  }
  const limit = Math.min(mediaByteLimit(), request.maxAcquiredBytes ?? Infinity);
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-media-window-"));
  try {
    const caBundle = await writeTrustedCaBundle(directory);
    const available = await probeMedia(video.canonicalUrl, video.platform, context);
    // Platform APIs sometimes round a terminal duration to whole seconds while
    // the media extractor reports the fractional stream duration. yt-dlp itself
    // clamps section_end to that duration; only this verified terminal case is
    // allowed to differ from the requested source end.
    const streamDuration = typeof available.duration === "number" && Number.isFinite(available.duration) && available.duration > 0 ? available.duration : undefined;
    const expectedEnd = end === video.durationSeconds && streamDuration !== undefined && Math.abs(streamDuration - video.durationSeconds) <= 1
      ? Math.min(end, streamDuration) : end;
    const expectedDuration = expectedEnd - start;
    if (expectedDuration <= 0) throw new AcquisitionError("INVALID_MEDIA_WINDOW", "The requested terminal interval falls beyond the reported stream duration.");
    const quality = request.sourceQuality ? resolveSourceQuality(request.sourceQuality) : undefined;
    const selection = quality ? selectYtDlpFormat(available, quality) : undefined;
    const selector = selection?.selector ?? defaultWindowSelector(available, request);
    const { stdout } = await guardedDownload(directory, limit, context, (guarded) => runYtDlp([
      "--no-continue", "--restrict-filenames", "--no-progress", "--max-filesize", String(limit),
      "--ffmpeg-location", getFfmpegPath(), "--merge-output-format", "mp4", "--print-json",
      "--download-sections", `*${start}-${end}`, "--force-keyframes-at-cuts",
      "--downloader-args", `ffmpeg_i:-rw_timeout 15000000 -tls_verify 1 -ca_file ${downloaderArgument(caBundle)}`,
      // Override --print-json's implicit quiet log level and cap FFmpeg's output.
      // Packets may overshoot -fs; the shared directory guard also checks size.
      "--downloader-args", `ffmpeg_o:-loglevel error -fs ${limit + 1}`,
      "-f", selector, "-o", path.join(directory, "window.%(ext)s"), "--", video.canonicalUrl,
    ], video.platform, guarded));
    const files = (await fs.readdir(directory)).filter((name) => MEDIA_FILE.test(name));
    if (files.length !== 1) throw new AcquisitionError("MEDIA_UNAVAILABLE", "The downloader did not produce exactly one bounded media window.");
    const mediaPath = path.join(directory, files[0]);
    const stat = await fs.stat(mediaPath);
    if (!stat.size || stat.size > limit) throw new AcquisitionError("RESOURCE_LIMIT", "The acquired window is empty or exceeds the configured media size.");
    const metadata = parseYtDlpMetadata(stdout) as ReturnType<typeof parseYtDlpMetadata> & { section_start?: unknown; section_end?: unknown };
    if (typeof metadata.section_start !== "number" || !Number.isFinite(metadata.section_start) || Math.abs(metadata.section_start - start) > 0.1
      || typeof metadata.section_end !== "number" || !Number.isFinite(metadata.section_end)
      || (Math.abs(metadata.section_end - end) > 0.1 && Math.abs(metadata.section_end - expectedEnd) > 0.1)) {
      throw new AcquisitionError("INVALID_MEDIA_WINDOW", "The downloader did not report finite source interval markers matching the requested window.");
    }
    const probe = await probeWindow(mediaPath, context);
    const durationTolerance = Math.max(0.5, expectedDuration * 0.005);
    if (probe.duration < expectedDuration - durationTolerance) {
      throw new AcquisitionError("MEDIA_INCOMPLETE", `The acquired media is incomplete (${probe.duration.toFixed(3)} seconds actual; ${expectedDuration.toFixed(3)} seconds expected).`, true);
    }
    if (probe.duration > expectedDuration + durationTolerance) {
      throw new AcquisitionError("INVALID_MEDIA_WINDOW", "The downloaded duration does not match the requested source interval; no whole-source fallback was accepted.");
    }
    const advertised = advertisedSelectedStreams(available, metadata);
    // A fresh bounded acquisition may recover a track that was advertised by
    // the selected source but missing from this attempt's actual media. Genuine
    // source absence remains non-retryable; unrelated formats cannot justify it.
    if ((request.mode === "language" || request.mode === "multimodal") && !probe.hasAudio) throw new AcquisitionError("AUDIO_UNAVAILABLE", "The acquired window has no audio stream for this research mode.", advertised.audio);
    if (request.mode !== "language" && !probe.hasVideo) throw new AcquisitionError("VIDEO_UNAVAILABLE", "The acquired window has no video stream for this research mode.", advertised.video);
    const report = quality && selection ? assessDownloadedQuality({ ...metadata, width: probe.width, height: probe.height, fps: probe.fps, requested_formats: undefined }, quality, selection) : undefined;
    if (report?.status === "degraded" && quality?.onUnavailable === "error") throw new AcquisitionError("QUALITY_UNAVAILABLE", "Downloaded window is below the requested source quality.");
    return {
      path: mediaPath, width: probe.width, height: probe.height, fps: probe.fps, durationSeconds: probe.duration,
      formatId: String(metadata.format_id ?? selection?.formatId ?? selector), bytes: stat.size, quality: report,
      dispose: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export interface PreparedResearchWindow { path: string; directory: string; dispose(): Promise<void> }

/** Re-encode an already-cut window to an explicit sampling/upload budget. */
export async function prepareResearchWindow(assetPath: string, mode: ResearchMode, detail: MediaDetail, context: ExecutionContext): Promise<PreparedResearchWindow> {
  remainingTime(context);
  if (mode === "language") throw new AcquisitionError("INVALID_REQUEST", "Language research should extract an audio track instead of preparing video frames.");
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-prepared-window-"));
  const output = path.join(directory, "research.mp4");
  const height = detail === "low" ? 360 : 720, fps = detail === "low" ? 1 : 5;
  try {
    await runProcess(getFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", assetPath,
      "-map", "0:v:0", ...(mode === "vision" ? ["-an"] : ["-map", "0:a:0"]),
      "-vf", `scale=w=-2:h='trunc(min(${height},ih)/2)*2':flags=area,fps=${fps}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", detail === "low" ? "30" : "25", "-threads", "2",
      ...(mode === "vision" ? [] : ["-c:a", "aac", "-b:a", "64k"]),
      "-map_metadata", "-1", "-movflags", "+faststart", "-fs", String(MAX_PREPARED_BYTES + 1), output,
    ], { timeout: remainingTime(context), signal: context.signal, maxBuffer: MIB });
    const stat = await fs.stat(output);
    if (!stat.size || stat.size > MAX_PREPARED_BYTES) throw new AcquisitionError("RESOURCE_LIMIT", "The prepared research window exceeds the 32 MiB upload budget.");
    // -fs can truncate successfully: duration validation catches that case too.
    const input = await probeWindow(assetPath, context), prepared = await probeWindow(output, context);
    if (Math.abs(prepared.duration - input.duration) > Math.max(1.5, input.duration * 0.005)) throw new AcquisitionError("RESOURCE_LIMIT", "Prepared media did not retain the acquired window duration within the upload budget.");
    if (!prepared.hasVideo || (mode === "multimodal" && !prepared.hasAudio) || (mode === "vision" && prepared.hasAudio)) throw new AcquisitionError("MEDIA_VALIDATION_FAILED", "Prepared media streams do not match the requested research mode.");
    return { path: output, directory, dispose: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    context.signal.throwIfAborted();
    if (error instanceof AcquisitionError) throw error;
    if ((error as { code?: string }).code === "ENOENT") throw new AcquisitionError("DEPENDENCY_MISSING", "The configured FFmpeg executable could not be started.");
    throw new AcquisitionError("MEDIA_TRANSFORM_FAILED", "FFmpeg could not prepare the bounded research window.");
  }
}
