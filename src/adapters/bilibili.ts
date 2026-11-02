import type { Captions, ExecutionContext, PlatformAdapter, ResearchRequest, SourceContext, VideoIdentity } from "../contracts.js";
import { getArchiveTags, getCaptionTrack, getComments, getVideo } from "../bilibili.js";
import { AcquisitionError, downloadMedia } from "../acquisition.js";

const HOSTS = ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv", "www.b23.tv"];

export async function resolveBilibiliUrl(input: string, context: ExecutionContext): Promise<{ bvid: string; page: number; canonicalUrl: string }> {
  let url = new URL(input);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    if (!HOSTS.includes(url.hostname.toLowerCase()) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) {
      throw new AcquisitionError("INVALID_URL", "Bilibili redirects must remain on supported public Bilibili hosts.");
    }
    url.protocol = "https:";
    if (!url.hostname.endsWith("b23.tv")) {
      const bvid = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i)?.[1];
      if (!bvid) throw new AcquisitionError("INVALID_URL", "A Bilibili BV video link is required; profiles, playlists and live streams are unsupported.");
      const rawPage = url.searchParams.get("p") ?? "1";
      const page = Number(rawPage);
      if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(page) || page < 1) throw new AcquisitionError("INVALID_URL", "Bilibili p must be a positive part number.");
      return { bvid, page, canonicalUrl: `https://www.bilibili.com/video/${bvid}/${page === 1 ? "" : `?p=${page}`}` };
    }
    context.signal.throwIfAborted();
    const response = await fetch(url, { redirect: "manual", signal: context.signal, headers: { "User-Agent": "Catalyst/0.1" } });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    await response.body?.cancel();
    throw new AcquisitionError("RESOLUTION_FAILED", `Bilibili share link did not resolve to a video (HTTP ${response.status}).`, true);
  }
  throw new AcquisitionError("RESOLUTION_FAILED", "Bilibili share link exceeded the redirect limit.");
}

function mapStatus(status: "present" | "empty" | "fetch_failed" | "disabled") {
  return status === "present" ? "available" as const : status === "empty" ? "absent" as const : status === "fetch_failed" ? "error" as const : "disabled" as const;
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly platform = "bilibili" as const;
  supports(url: URL) { return HOSTS.includes(url.hostname.toLowerCase()); }
  async resolve(request: ResearchRequest, context: ExecutionContext): Promise<SourceContext> {
    const identity = await resolveBilibiliUrl(request.url, context);
    const video = await getVideo(identity.bvid, identity.page, context.signal);
    if (!Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0 || !Number.isFinite(video.cid)) throw new AcquisitionError("INVALID_METADATA", "Bilibili did not return a valid part identity and duration.");
    const tags = await getArchiveTags(identity.bvid, context.signal);
    const captions: Captions = request.mode === "language" ? await getCaptionTrack(video, request.language, context.signal) : { status: "not_requested", kind: "unknown", cues: [] };
    const community = request.includeComments ? await getComments(video.aid, context.signal) : { status: "disabled" as const, sampled: [], displayed: [] };
    const comments = { status: mapStatus(community.status), items: community.displayed.map((item) => ({ id: item.rpid === undefined ? undefined : String(item.rpid), text: item.content?.message ?? "", author: item.member?.uname, likes: item.like })) };
    const warnings: string[] = [];
    if (tags.status === "fetch_failed") warnings.push("Bilibili tags could not be retrieved.");
    if (comments.status === "error") warnings.push("Bilibili community comments could not be retrieved.");
    if (captions.status === "error" || captions.status === "auth_required") warnings.push(captions.reason ?? "Bilibili captions could not be retrieved.");
    return {
      video: { platform: this.platform, id: video.bvid, partId: String(video.cid), sourceUrl: request.url, canonicalUrl: identity.canonicalUrl, title: video.title, description: video.description, uploader: video.owner.name, durationSeconds: video.durationSeconds,
        metadata: { part: identity.page, aid: video.aid, tags: tags.tags, tags_status: tags.status, category: video.category, stats: video.stats, published_at: video.publishedAt, uploader_id: video.owner.mid } },
      captions, comments, warnings,
      capabilities: { metadata: { status: "available" }, captions: { status: captions.status, reason: captions.reason }, media: { status: "unknown" }, comments: { status: comments.status } },
    };
  }
  acquire(video: VideoIdentity, request: ResearchRequest, context: ExecutionContext) { return downloadMedia(video, request, context); }
}
