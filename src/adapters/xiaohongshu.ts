import type { Captions, ExecutionContext, PlatformAdapter, ResearchRequest, SourceContext, VideoIdentity } from "../contracts.js";
import { AcquisitionError, downloadMedia, probeMedia, remainingTime } from "../acquisition.js";

const NOTE_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const SHARE_HOSTS = new Set(["xhslink.com", "www.xhslink.com", "xhslink.cn", "www.xhslink.cn"]);
const NOTE_PATH = /^\/(explore|discovery\/item)\/([a-fA-F0-9]{24})\/?$/;
const MAX_REDIRECTS = 5;

function acceptedUrl(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && (NOTE_HOSTS.has(url.hostname.toLowerCase()) || SHARE_HOSTS.has(url.hostname.toLowerCase()));
}

function upgradeShareUrl(url: URL): URL {
  const result = new URL(url);
  if (result.protocol === "http:" && SHARE_HOSTS.has(result.hostname.toLowerCase()) && !result.username && !result.password && !result.port) {
    result.protocol = "https:";
  }
  return result;
}

/** The native share sheet wraps one URL in human-readable text. Never choose among multiple links. */
export function extractXiaohongshuShareUrl(input: string): string | undefined {
  const matches = input.match(/https?:\/\/[^\s<>"'，。！？；（）【】]+/giu) ?? [];
  if (matches.length !== 1) return undefined;
  const candidate = matches[0].replace(/[),.;!?\]}>]+$/, "");
  try {
    const url = upgradeShareUrl(new URL(candidate));
    return acceptedUrl(url) ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Retain acquisition parameters internally; ResearchResult renders a public URL separately. */
export async function resolveXiaohongshuUrl(input: string, context: ExecutionContext): Promise<{ id: string; canonicalUrl: string }> {
  let url: URL;
  const source = extractXiaohongshuShareUrl(input.trim());
  if (!source) throw new AcquisitionError("INVALID_URL", "Provide one Xiaohongshu note/share URL; share text with multiple links is ambiguous.");
  try { url = upgradeShareUrl(new URL(source)); }
  catch { throw new AcquisitionError("INVALID_URL", "A valid Xiaohongshu video-note or share URL is required."); }
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    context.signal.throwIfAborted();
    if (!acceptedUrl(url)) {
      throw new AcquisitionError("INVALID_URL", "Xiaohongshu links and redirects must use HTTPS on supported note/share hosts, without credentials or nonstandard ports.");
    }
    if (NOTE_HOSTS.has(url.hostname.toLowerCase())) {
      if (redirects > 0 && /^\/login(?:\/|$)/.test(url.pathname)) {
        throw new AcquisitionError("AUTH_REQUIRED", "Xiaohongshu redirected the share link to its login page; an explicitly configured authorized session may be required.");
      }
      if (redirects > 0 && /^\/404(?:\/|$)/.test(url.pathname)) {
        throw new AcquisitionError("CONTENT_UNAVAILABLE", "Xiaohongshu redirected the share link to an unavailable-note page; this response does not identify the note type.");
      }
      const match = NOTE_PATH.exec(url.pathname);
      if (!match) throw new AcquisitionError("INVALID_URL", "A Xiaohongshu explore or discovery/item note URL is required; profiles, searches and live pages are unsupported.");
      const id = match[2].toLowerCase();
      const canonical = new URL(`https://www.xiaohongshu.com/${match[1]}/${id}`);
      // xsec_token and related original share parameters can be necessary for
      // access. They are never copied into the public metadata whitelist.
      canonical.search = url.search;
      return { id, canonicalUrl: canonical.toString() };
    }
    if (redirects === MAX_REDIRECTS) break;
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(remainingTime(context))]);
    const response = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "Catalyst/0.1", Accept: "text/html" } });
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400 && location) {
      try { url = new URL(location, url); }
      catch { throw new AcquisitionError("RESOLUTION_FAILED", "The Xiaohongshu share link returned an invalid redirect."); }
      continue;
    }
    if (response.status === 401) throw new AcquisitionError("AUTH_REQUIRED", "The Xiaohongshu share link requires an authorized session.");
    if ([403, 412].includes(response.status)) throw new AcquisitionError("ACCESS_BLOCKED", `Xiaohongshu rejected share-link access (HTTP ${response.status}).`);
    if ([404, 410].includes(response.status)) throw new AcquisitionError("CONTENT_UNAVAILABLE", `The Xiaohongshu share link is unavailable (HTTP ${response.status}).`);
    throw new AcquisitionError("RESOLUTION_FAILED", `The Xiaohongshu share link did not resolve to a video note (HTTP ${response.status}).`, response.status === 429 || response.status >= 500);
  }
  throw new AcquisitionError("RESOLUTION_FAILED", "The Xiaohongshu share link exceeded the redirect limit.");
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Some upstream Xiaohongshu formats carry duration while the top level does not. */
export function xiaohongshuDuration(data: Record<string, unknown>): { seconds: number; origin: "metadata" | "format_metadata" } {
  if (positiveNumber(data.duration)) return { seconds: data.duration, origin: "metadata" };
  const formats = Array.isArray(data.formats) ? data.formats : [];
  const durations = formats.flatMap((item) => item && typeof item === "object" && positiveNumber(item.duration) ? [item.duration as number] : []);
  if (!durations.length) throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu did not report a finite positive video duration; a source interval cannot be verified.");
  const minimum = durations.reduce((left, right) => Math.min(left, right));
  const maximum = durations.reduce((left, right) => Math.max(left, right));
  if (maximum - minimum > Math.max(1, minimum * 0.01)) {
    throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu advertised inconsistent stream durations; a reliable source duration could not be selected.");
  }
  return { seconds: maximum, origin: "format_metadata" };
}

function sourceType(data: Record<string, unknown>): string | undefined {
  for (const value of [data.note_type, data.content_type, data.type, data._type]) {
    if (typeof value === "string") return value.toLowerCase();
  }
  return undefined;
}

function hasVideoFormat(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.formats)) return false;
  return data.formats.some((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const format = item as Record<string, unknown>;
    const extension = typeof format.ext === "string" ? format.ext.toLowerCase() : "";
    if (format.vcodec === "none" || ["m4a", "mp3", "wav", "ogg", "opus", "aac", "flac", "jpg", "jpeg", "png", "webp", "gif", "avif", "mhtml"].includes(extension)) return false;
    return (typeof format.vcodec === "string" && !["none", "unknown"].includes(format.vcodec)) || positiveNumber(format.width) || positiveNumber(format.height)
      || ["mp4", "webm", "mkv", "mov", "flv", "m4v", "3gp", "avi", "ts"].includes(extension);
  });
}

function publicMetadata(data: Record<string, unknown>, durationOrigin: string): Record<string, unknown> {
  const fields: Record<string, unknown> = { duration_origin: durationOrigin };
  for (const key of ["uploader_id", "upload_date", "language"] as const) {
    if (typeof data[key] === "string") fields[key] = data[key];
  }
  for (const key of ["timestamp", "view_count", "like_count", "comment_count"] as const) {
    if (typeof data[key] === "number" && Number.isFinite(data[key])) fields[key] = data[key];
  }
  if (Array.isArray(data.tags)) fields.tags = data.tags.filter((tag): tag is string => typeof tag === "string");
  const type = sourceType(data);
  if (type) fields.note_type = type;
  return fields;
}

export class XiaohongshuAdapter implements PlatformAdapter {
  readonly platform = "xiaohongshu" as const;
  supports(url: URL): boolean { return acceptedUrl(upgradeShareUrl(url)); }

  async resolve(request: ResearchRequest, context: ExecutionContext): Promise<SourceContext> {
    const identity = await resolveXiaohongshuUrl(request.url, context);
    let data: Record<string, unknown>;
    try { data = await probeMedia(identity.canonicalUrl, this.platform, context); }
    catch (error) {
      if (error instanceof AcquisitionError && error.code === "ACQUISITION_FAILED" && /no (?:video )?formats (?:were )?found/i.test(error.message)) {
        throw new AcquisitionError("MEDIA_UNAVAILABLE", "Xiaohongshu returned no downloadable video formats. Keep the original share parameters and check source access; the response alone does not identify an image note.");
      }
      throw error;
    }
    const types = [data.note_type, data.content_type, data.type, data._type].filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
    if (data.is_live === true || types.some((type) => ["normal", "image", "images", "photo", "photos", "playlist", "live", "livestream"].includes(type))) {
      throw new AcquisitionError("UNSUPPORTED_CONTENT", "This preview supports finite Xiaohongshu video notes; image notes, collections and live content are unsupported.");
    }
    if (typeof data.id !== "string" || data.id.toLowerCase() !== identity.id) {
      throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu returned no matching identity for the requested note.");
    }
    if (!hasVideoFormat(data)) {
      throw new AcquisitionError("MEDIA_UNAVAILABLE", "Xiaohongshu returned no advertised video formats. The note may be inaccessible or unavailable; this does not establish that it is an image note.");
    }
    const duration = xiaohongshuDuration(data);
    const captions: Captions = { status: request.mode === "language" ? "unsupported" : "not_requested", kind: "unknown", cues: [],
      ...(request.mode === "language" ? { reason: "Platform subtitle extraction is not implemented for Xiaohongshu; language research uses an explicitly recorded audio transcription fallback." } : {}) };
    const comments = { status: request.includeComments ? "unsupported" as const : "disabled" as const, items: [],
      ...(request.includeComments ? { reason: "Xiaohongshu community comment sampling is not implemented in this preview." } : {}) };
    const warnings = [captions.reason, comments.reason].filter((value): value is string => Boolean(value));
    if (duration.origin === "format_metadata") warnings.push("Source duration comes from advertised platform stream metadata, not a measured frame timeline.");
    return {
      video: { platform: this.platform, id: identity.id, sourceUrl: request.url, canonicalUrl: identity.canonicalUrl,
        title: typeof data.title === "string" ? data.title : "", description: typeof data.description === "string" ? data.description : "",
        uploader: typeof data.uploader === "string" ? data.uploader : typeof data.uploader_id === "string" ? data.uploader_id : undefined,
        durationSeconds: duration.seconds, metadata: publicMetadata(data, duration.origin) },
      captions, comments, warnings,
      capabilities: { metadata: { status: "available" }, captions: { status: captions.status, reason: captions.reason }, media: { status: "unknown" }, comments: { status: comments.status, reason: comments.reason } },
    };
  }

  acquire(video: VideoIdentity, request: ResearchRequest, context: ExecutionContext) { return downloadMedia(video, request, context); }
}
