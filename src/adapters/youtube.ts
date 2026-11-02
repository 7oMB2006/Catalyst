import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CaptionCue, Captions, ExecutionContext, PlatformAdapter, ResearchRequest, SourceContext, VideoIdentity } from "../contracts.js";
import { AcquisitionError, downloadMedia, probeMedia, runYtDlp, safeDiagnostic } from "../acquisition.js";

export function youtubeId(url: URL): string {
  let id: string | null;
  if (url.hostname === "youtu.be") id = url.pathname.split("/")[1];
  else if (url.pathname === "/watch") id = url.searchParams.get("v");
  else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] ?? null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new AcquisitionError("INVALID_URL", "A YouTube video URL with an 11-character video ID is required; channel and playlist URLs are unsupported.");
  return id;
}

type Track = { ext?: string; url?: string; name?: string };
type Tracks = Record<string, Track[]>;

function chooseTrack(metadata: Record<string, unknown>, preferred?: string): { language: string; kind: "manual" | "automatic" | "unknown"; automatic: boolean; reason?: string } | undefined {
  const manual = (metadata.subtitles ?? {}) as Tracks;
  const automatic = (metadata.automatic_captions ?? {}) as Tracks;
  const original = typeof metadata.language === "string" ? metadata.language : undefined;
  const target = preferred ?? original;
  const pick = (tracks: Tracks, fallback: boolean): string | undefined => {
    const keys = Object.keys(tracks).filter((key) => tracks[key].some((track) => track.ext === "json3"));
    const matched = target ? keys.find((key) => key.toLowerCase() === target.toLowerCase()) ?? keys.find((key) => key.toLowerCase().startsWith(`${target.toLowerCase()}-`)) : undefined;
    return matched ?? (fallback ? keys.find((key) => key === "en") ?? keys.find((key) => !key.includes("-")) ?? keys[0] : undefined);
  };
  const matchedManual = pick(manual, false);
  const matchedAutomatic = pick(automatic, false);
  const language = matchedManual ?? matchedAutomatic ?? (!preferred ? pick(manual, true) ?? pick(automatic, true) : undefined);
  if (!language) return undefined;
  const isAutomatic = !manual[language]?.some((track) => track.ext === "json3");
  const tracks = isAutomatic ? automatic[language] : manual[language];
  const translatedUrl = tracks.some((track) => {
    try { return Boolean(track.url && new URL(track.url).searchParams.has("tlang")); } catch { return false; }
  });
  const differentSourceLanguage = Boolean(original && language.split("-")[0] !== original.split("-")[0]);
  const uncertainTranslation = translatedUrl || (isAutomatic && differentSourceLanguage);
  return { language, automatic: isAutomatic, kind: uncertainTranslation ? "unknown" : isAutomatic ? "automatic" : "manual",
    ...(uncertainTranslation ? { reason: translatedUrl ? "The selected platform caption track is translated; its timing is not alignment to original-language words." : "The automatic track language differs from the source-reported language; original versus translated origin is unverified." } : {}) };
}

export function parseJson3Captions(value: unknown): CaptionCue[] {
  const data = value as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  const cues: CaptionCue[] = [];
  for (const event of data.events ?? []) {
    const content = (event.segs ?? []).map((segment) => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    const start = Number(event.tStartMs) / 1000;
    const duration = Number(event.dDurationMs) / 1000;
    if (!content || !Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0) continue;
    cues.push({ start, end: start + duration, content });
  }
  return cues;
}

async function fetchCaptions(metadata: Record<string, unknown>, url: string, preferred: string | undefined, context: ExecutionContext): Promise<Captions> {
  const track = chooseTrack(metadata, preferred);
  if (!track) return { status: "absent", kind: "unknown", cues: [], reason: preferred ? "No JSON3 caption track matches the requested language." : "No platform JSON3 caption track was advertised." };
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-captions-"));
  try {
    // Request an exact escaped language to avoid interpreting user input as a yt-dlp regex.
    const language = track.language.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await runYtDlp(["--skip-download", track.automatic ? "--write-auto-subs" : "--write-subs", "--sub-langs", `^${language}$`, "--sub-format", "json3", "-o", path.join(directory, "caption.%(ext)s"), "--", url], "youtube", context);
    const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json3"));
    if (!files.length) return { status: "error", kind: track.kind, language: track.language, cues: [], reason: "The advertised caption track could not be downloaded." };
    const filename = path.join(directory, files[0]);
    const stat = await fs.stat(filename);
    if (stat.size > 8 * 1024 * 1024) throw new AcquisitionError("RESOURCE_LIMIT", "The caption track exceeds the 8 MiB limit.");
    const cues = parseJson3Captions(JSON.parse(await fs.readFile(filename, "utf8")));
    return { status: cues.length ? "available" : "absent", kind: track.kind, language: track.language, cues, reason: track.reason };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { status: error instanceof AcquisitionError && error.code === "AUTH_REQUIRED" ? "auth_required" : "error", kind: track.kind, language: track.language, cues: [], reason: safeDiagnostic(error instanceof Error ? error.message : String(error)) };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = "youtube" as const;
  supports(url: URL): boolean {
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && (!url.port || ["80", "443"].includes(url.port))
      && ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url.hostname.toLowerCase());
  }
  async resolve(request: ResearchRequest, context: ExecutionContext): Promise<SourceContext> {
    const input = new URL(request.url);
    if (!this.supports(input)) throw new AcquisitionError("INVALID_URL", "The URL is not on YouTube.");
    const id = youtubeId(input);
    const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
    const data = await probeMedia(canonicalUrl, this.platform, context);
    if (data._type === "playlist" || data.is_live === true) throw new AcquisitionError("UNSUPPORTED_CONTENT", "This preview supports finite videos, not playlists or live streams.");
    const duration = Number(data.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new AcquisitionError("INVALID_METADATA", "YouTube did not provide a finite positive video duration.");
    const captions: Captions = request.mode === "language" ? await fetchCaptions(data, canonicalUrl, request.language, context) : { status: "not_requested", kind: "unknown", cues: [] };
    const comments = { status: request.includeComments ? "unsupported" as const : "disabled" as const, items: [], ...(request.includeComments ? { reason: "YouTube community comment sampling is not implemented in this preview." } : {}) };
    const warnings = [];
    if (captions.reason) warnings.push(captions.reason);
    if (comments.reason) warnings.push(comments.reason);
    return {
      video: { platform: this.platform, id, sourceUrl: request.url, canonicalUrl, title: String(data.title ?? ""), description: String(data.description ?? ""), uploader: String(data.uploader ?? data.channel ?? ""), durationSeconds: duration,
        metadata: { upload_date: data.upload_date ?? null, view_count: data.view_count ?? null, tags: Array.isArray(data.tags) ? data.tags : [], language: data.language ?? null } },
      captions, comments, warnings,
      capabilities: { metadata: { status: "available" }, captions: { status: captions.status, reason: captions.reason }, media: { status: "unknown" }, comments: { status: comments.status, reason: comments.reason } },
    };
  }
  acquire(video: VideoIdentity, request: ResearchRequest, context: ExecutionContext) { return downloadMedia(video, request, context); }
}
