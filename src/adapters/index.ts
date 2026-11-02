import type { PlatformAdapter } from "../contracts.js";
import { BilibiliAdapter } from "./bilibili.js";
import { YouTubeAdapter } from "./youtube.js";
import { AcquisitionError } from "../acquisition.js";

export { BilibiliAdapter, YouTubeAdapter };

export function parseSourceUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new AcquisitionError("INVALID_URL", "A valid public video URL is required."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) {
    throw new AcquisitionError("INVALID_URL", "Only public HTTP(S) platform URLs without embedded credentials or nonstandard ports are accepted.");
  }
  return url;
}

export function getAdapter(input: string): PlatformAdapter {
  const url = parseSourceUrl(input);
  for (const adapter of [new BilibiliAdapter(), new YouTubeAdapter()]) {
    if (adapter.supports(url)) return adapter;
  }
  throw new AcquisitionError("UNSUPPORTED_PLATFORM", "Unsupported video platform. This preview supports Bilibili and YouTube video URLs.");
}
