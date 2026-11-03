import type { Captions, ExecutionContext, PlatformAdapter, ResearchRequest, SourceContext, VideoIdentity } from "../contracts.js";
import { getArchiveTags, getCaptionTrack, getComments, getVideo, resolveBilibiliUrl } from "../bilibili.js";
import { AcquisitionError, downloadMedia } from "../acquisition.js";

const HOSTS = ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv", "www.b23.tv"];

export { resolveBilibiliUrl } from "../bilibili.js";

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
        metadata: { part: identity.page, ...(video.partTitle ? { part_title: video.partTitle } : {}), aid: video.aid, tags: tags.tags, tags_status: tags.status, category: video.category, stats: video.stats, published_at: video.publishedAt, uploader_id: video.owner.mid } },
      captions, comments, warnings,
      capabilities: { metadata: { status: "available" }, captions: { status: captions.status, reason: captions.reason }, media: { status: "unknown" }, comments: { status: comments.status } },
    };
  }
  acquire(video: VideoIdentity, request: ResearchRequest, context: ExecutionContext) { return downloadMedia(video, request, context); }
}
