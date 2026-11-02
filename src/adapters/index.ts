import type { PlatformAdapter } from "../contracts.js";
import { BilibiliAdapter } from "./bilibili.js";
import { YouTubeAdapter } from "./youtube.js";
import { XiaohongshuAdapter, extractXiaohongshuShareUrl } from "./xiaohongshu.js";
import { AcquisitionError } from "../acquisition.js";

export { BilibiliAdapter, YouTubeAdapter, XiaohongshuAdapter };

export function parseSourceUrl(input: string): URL {
  let url: URL;
  const trimmed = input.trim();
  const source = /\s/.test(trimmed) || !/^https?:\/\//i.test(trimmed) ? extractXiaohongshuShareUrl(trimmed) : trimmed;
  if (!source) throw new AcquisitionError("INVALID_URL", "A valid public video URL or Xiaohongshu share text containing one supported URL is required.");
  try { url = new URL(source); } catch { throw new AcquisitionError("INVALID_URL", "A valid public video URL or Xiaohongshu share text containing one supported URL is required."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) {
    throw new AcquisitionError("INVALID_URL", "Only public HTTP(S) platform URLs without embedded credentials or nonstandard ports are accepted.");
  }
  return url;
}

export function getAdapter(input: string): PlatformAdapter {
  const url = parseSourceUrl(input);
  for (const adapter of [new BilibiliAdapter(), new YouTubeAdapter(), new XiaohongshuAdapter()]) {
    if (adapter.supports(url)) return adapter;
  }
  throw new AcquisitionError("UNSUPPORTED_PLATFORM", "Unsupported video platform. This preview accepts Bilibili, YouTube and Xiaohongshu video-note URLs.");
}
