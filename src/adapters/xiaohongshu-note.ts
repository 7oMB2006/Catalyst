import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AcquisitionError, remainingTime } from "../acquisition.js";
import { ProcessExecutionError, runProcess } from "../process.js";
import { getFfmpegPath } from "../video-analysis.js";
import type { ExecutionContext } from "../contracts.js";
import type { NoteImages, NotePage, NoteResearchRequest, XiaohongshuNoteSource } from "../note-contracts.js";
import { resolveXiaohongshuUrl } from "./xiaohongshu.js";

const NOTE_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const HTML_LIMIT = 8 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const TOTAL_IMAGE_LIMIT = 128 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_REDIRECTS = 5;
const MAX_PAGES = 128;
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

type ObjectData = Record<string, unknown>;
function object(value: unknown): ObjectData | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : undefined; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }

function publicNoteUrl(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && NOTE_HOSTS.has(url.hostname.toLowerCase());
}

function imageUrl(raw: string, allowUpgrade: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AcquisitionError("INVALID_METADATA", "A note image has an invalid source URL."); }
  if (allowUpgrade && url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.toLowerCase().endsWith(".xhscdn.com")) {
    throw new AcquisitionError("INVALID_METADATA", "Note images and redirects must use an official HTTPS xhscdn.com image host without credentials or nonstandard ports.");
  }
  return url;
}

function platformStatus(url: URL): void {
  if (/^\/login(?:\/|$)/.test(url.pathname)) throw new AcquisitionError("AUTH_REQUIRED", "Xiaohongshu returned a login page instead of the requested note.");
  if (/^\/404(?:\/|$)/.test(url.pathname)) throw new AcquisitionError("CONTENT_UNAVAILABLE", "Xiaohongshu returned an unavailable-note page.");
}

async function guardedFetch(initial: URL, kind: "note" | "image", context: ExecutionContext): Promise<{ response: Response; signal: AbortSignal }> {
  let url = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(remainingTime(context))]);
    if (kind === "note") {
      if (!publicNoteUrl(url)) throw new AcquisitionError("INVALID_URL", "A note redirect left the allowed HTTPS Xiaohongshu hosts.");
      platformStatus(url);
    } else imageUrl(url.toString(), false);
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", credentials: "omit", signal,
        headers: { "User-Agent": MOBILE_USER_AGENT, Accept: kind === "note" ? "text/html" : "image/jpeg,image/png,image/webp,image/gif", Referer: "https://www.xiaohongshu.com/" } });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AcquisitionError) throw error;
      throw new AcquisitionError("UPSTREAM_ERROR", "The Xiaohongshu source request failed.", true);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      void response.body?.cancel().catch(() => undefined);
      if (!location) throw new AcquisitionError("RESOLUTION_FAILED", "A Xiaohongshu redirect had no destination.");
      if (redirects === MAX_REDIRECTS) throw new AcquisitionError("RESOLUTION_FAILED", "The Xiaohongshu source exceeded its redirect limit.");
      try { url = new URL(location, url); } catch { throw new AcquisitionError("RESOLUTION_FAILED", "A Xiaohongshu redirect had an invalid destination."); }
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401) throw new AcquisitionError("AUTH_REQUIRED", "The Xiaohongshu source requires an authorized session.");
      if ([403, 412].includes(response.status)) throw new AcquisitionError("ACCESS_BLOCKED", "Xiaohongshu rejected source access.");
      if ([404, 410].includes(response.status)) throw new AcquisitionError("CONTENT_UNAVAILABLE", "The Xiaohongshu source is unavailable.");
      throw new AcquisitionError("UPSTREAM_ERROR", `Xiaohongshu returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    }
    return { response, signal };
  }
  throw new AcquisitionError("RESOLUTION_FAILED", "The Xiaohongshu source exceeded its redirect limit.");
}

/** Read incrementally so chunked responses cannot bypass the byte budget. */
async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const advertised = response.headers.get("content-length");
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new AcquisitionError("RESOURCE_LIMIT", "The Xiaohongshu source exceeds its byte limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let bytes = 0;
  const chunks: Buffer[] = [];
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { void reader.cancel().catch(() => undefined); reject(signal.reason ?? new DOMException("Source acquisition cancelled.", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await Promise.race([reader.read(), cancelled]);
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new AcquisitionError("RESOURCE_LIMIT", "The Xiaohongshu source exceeds its byte limit.");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof AcquisitionError || signal.aborted || /AbortError|TimeoutError/.test((error as Error)?.name ?? "")) throw error;
    throw new AcquisitionError("UPSTREAM_ERROR", "The Xiaohongshu source response could not be read.", true);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* An aborted read can retain its lock until cancellation settles. */ }
  }
}

/** Extract only a balanced JSON object; page JavaScript is never evaluated. */
function stateObject(html: string, name: string): ObjectData | undefined {
  const marker = new RegExp(`\\bwindow\\.${name}\\s*=`, "g");
  const match = marker.exec(html);
  if (!match) return undefined;
  let start = marker.lastIndex;
  while (/\s/.test(html[start] ?? "") && start < html.length) start++;
  if (html[start] !== "{") throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu page state is not a JSON object.");
  const stack: string[] = [];
  let quoted = false, escaped = false, end = -1, cursor = start;
  const substitutions: Array<{ start: number; end: number }> = [];
  for (; cursor < html.length; cursor++) {
    const ch = html[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      if (stack.length > 256) throw new AcquisitionError("RESOURCE_LIMIT", "Xiaohongshu page state exceeds its nesting limit.");
    } else if (ch === "}" || ch === "]") {
      if (stack.pop() !== (ch === "}" ? "{" : "[")) throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu page state has unbalanced JSON delimiters.");
      if (!stack.length) { end = cursor + 1; break; }
    } else if (html.startsWith("undefined", cursor) && !/[\w$]/.test(html[cursor - 1] ?? "") && !/[\w$]/.test(html[cursor + 9] ?? "")) {
      substitutions.push({ start: cursor, end: cursor + 9 });
      cursor += 8;
    }
  }
  if (end < 0 || quoted) throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu page state is incomplete JSON.");
  let at = start, json = "";
  for (const replacement of substitutions) { json += html.slice(at, replacement.start) + "null"; at = replacement.end; }
  json += html.slice(at, end);
  try {
    const parsed = object(JSON.parse(json));
    if (!parsed) throw new Error("Not an object");
    return parsed;
  } catch { throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu page state contains unsupported non-JSON syntax."); }
}

function parseNote(html: string, id: string): ObjectData {
  const setup = stateObject(html, "__SETUP_SERVER_STATE__");
  const mobile = object(object(setup?.LAUNCHER_SSR_STORE_PAGE_DATA)?.noteData);
  if (mobile) return validateIdentity(mobile, id);
  const initial = stateObject(html, "__INITIAL_STATE__");
  const map = object(object(initial?.note)?.noteDetailMap);
  const desktop = object(object(map?.[id])?.note);
  if (desktop) return validateIdentity(desktop, id);
  if (/请先登录|登录后查看|请登录后查看/.test(html)) throw new AcquisitionError("AUTH_REQUIRED", "Xiaohongshu returned a login prompt without the requested note data.");
  throw new AcquisitionError("MEDIA_UNAVAILABLE", "Xiaohongshu returned no identifiable note data; the response does not establish the source content type.");
}

function validateIdentity(note: ObjectData, id: string): ObjectData {
  const actual = note.noteId ?? note.note_id ?? note.id;
  if (typeof actual !== "string" || actual.toLowerCase() !== id) throw new AcquisitionError("INVALID_METADATA", "Xiaohongshu returned no matching identity for the requested note.");
  return note;
}

function pageSource(image: ObjectData, index: number): NotePage {
  const tracks = Array.isArray(image.infoList) ? image.infoList.map(object).filter((value): value is ObjectData => Boolean(value)) : [];
  const preferred = tracks.find((track) => ["H5_DTL", "WB_DFT"].includes(String(track.imageScene))) ?? tracks[0];
  const raw = image.urlDefault ?? image.url ?? preferred?.url ?? image.urlPre;
  if (typeof raw !== "string") throw new AcquisitionError("INVALID_METADATA", "A Xiaohongshu note page has no image source.");
  return { index, url: imageUrl(raw, true).toString(), ...(positive(image.width) ? { width: image.width } : {}), ...(positive(image.height) ? { height: image.height } : {}) };
}

export async function resolveXiaohongshuNote(request: NoteResearchRequest, context: ExecutionContext): Promise<XiaohongshuNoteSource> {
  const identity = await resolveXiaohongshuUrl(request.url, context);
  const url = new URL(identity.canonicalUrl);
  url.pathname = `/explore/${identity.id}`;
  const { response, signal } = await guardedFetch(url, "note", context);
  const html = (await boundedBody(response, HTML_LIMIT, signal)).toString("utf8");
  const note = parseNote(html, identity.id);
  const type = typeof note.type === "string" ? note.type.toLowerCase() : "";
  const contentType = type === "video" ? "video_note" : ["normal", "image", "images", "photo", "photos"].includes(type) ? "image_note" : undefined;
  if (!contentType) throw new AcquisitionError("UNSUPPORTED_CONTENT", "The source did not identify itself as a supported Xiaohongshu image or video note.");
  const images = contentType === "image_note" && Array.isArray(note.imageList) ? note.imageList : [];
  if (images.length > MAX_PAGES) throw new AcquisitionError("RESOURCE_LIMIT", "The Xiaohongshu note exceeds the page-count limit.");
  const pages = images.map((value, index) => {
    const image = object(value);
    if (!image) throw new AcquisitionError("INVALID_METADATA", "A Xiaohongshu note page has invalid image metadata.");
    return pageSource(image, index + 1);
  });
  const user = object(note.user);
  const uploader = typeof user?.nickName === "string" ? user.nickName : typeof user?.nickname === "string" ? user.nickname : undefined;
  return { id: identity.id, sourceUrl: request.url, canonicalUrl: identity.canonicalUrl,
    title: typeof note.title === "string" ? note.title : "", description: typeof note.desc === "string" ? note.desc : "", uploader, contentType, pages };
}

function rasterExtension(bytes: Buffer, mime: string): string {
  if (mime && !["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/avif", "application/octet-stream"].includes(mime)) throw new AcquisitionError("INVALID_MEDIA", "A note image returned an unsupported content type.");
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(bytes.toString("ascii", 8, 32))) return "avif";
  throw new AcquisitionError("INVALID_MEDIA", "A note image did not contain a supported raster image signature.");
}

/** Normalize at acquisition so every OCR/vision backend receives supported bytes. */
async function normalizeAvif(filename: string, output: string, limit: number, context: ExecutionContext): Promise<{ width: number; height: number; bytes: number }> {
  if (limit <= 0) throw new AcquisitionError("RESOURCE_LIMIT", "Normalized note images exceed the total byte limit.");
  try {
    await runProcess(getFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-max_alloc", String(256 * 1024 * 1024),
      "-protocol_whitelist", "file,pipe", "-max_pixels", String(MAX_IMAGE_PIXELS), "-threads", "1", "-i", filename,
      "-map", "0:v:0", "-frames:v", "1", "-map_metadata", "-1", "-c:v", "png", "-threads", "1",
      "-f", "image2", "-update", "1", "-fs", String(limit + 1), output,
    ], { signal: context.signal, timeout: Math.min(30_000, remainingTime(context)), maxBuffer: 1024 * 1024 });
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof ProcessExecutionError && ["ETIMEDOUT", "ABORT_ERR"].includes(String(error.code))) throw new AcquisitionError("TIMEOUT", "AVIF normalization exceeded its processing deadline.", true);
    if (error instanceof ProcessExecutionError && error.code === "ENOENT") throw new AcquisitionError("DEPENDENCY_MISSING", "AVIF normalization needs a working FFmpeg executable; check FFMPEG_PATH.");
    throw new AcquisitionError("IMAGE_CONVERSION_FAILED", "FFmpeg could not normalize this AVIF page to PNG within the decoding limits; use an FFmpeg build with AVIF decoding support.");
  }
  remainingTime(context);
  const stat = await fs.stat(output).catch(() => undefined);
  if (!stat?.isFile()) throw new AcquisitionError("IMAGE_CONVERSION_FAILED", "AVIF normalization did not produce an available PNG image.");
  // FFmpeg's -fs can overshoot by a packet; reject oversized output explicitly.
  if (stat.size <= 0 || stat.size > limit) throw new AcquisitionError("RESOURCE_LIMIT", "The normalized note image exceeds its byte limit.");
  const handle = await fs.open(output, "r").catch(() => undefined);
  if (!handle) throw new AcquisitionError("IMAGE_CONVERSION_FAILED", "The normalized note image could not be opened for validation.");
  const header = Buffer.alloc(24);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString("ascii", 12, 16) !== "IHDR") throw new AcquisitionError("INVALID_MEDIA", "AVIF normalization did not produce a PNG image.");
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) throw new AcquisitionError("RESOURCE_LIMIT", "The normalized note image exceeds its decoded pixel limit.");
  await fs.rm(filename);
  return { width, height, bytes: stat.size };
}

export async function acquireNoteImages(source: XiaohongshuNoteSource, pages: number[], context: ExecutionContext): Promise<NoteImages> {
  context.signal.throwIfAborted();
  remainingTime(context);
  if (source.contentType !== "image_note") throw new AcquisitionError("UNSUPPORTED_CONTENT", "Image acquisition requires a confirmed Xiaohongshu image note.");
  if (pages.length > MAX_PAGES || new Set(pages).size !== pages.length || pages.some((page) => !Number.isSafeInteger(page) || page < 1)) throw new AcquisitionError("INVALID_PAGE_RANGE", "Select distinct positive note page numbers.");
  const selected = pages.map((index) => {
    const page = source.pages.find((candidate) => candidate.index === index);
    if (!page) throw new AcquisitionError("INVALID_PAGE_RANGE", "A selected page is outside the source note.");
    imageUrl(page.url, true);
    return page;
  }).sort((left, right) => left.index - right.index);
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-note-images-"));
  const acquired: NoteImages["pages"] = [];
  let bytes = 0;
  let retainedBytes = 0;
  try {
    for (const page of selected) {
      const budget = Math.min(IMAGE_LIMIT, TOTAL_IMAGE_LIMIT - bytes);
      if (budget <= 0) throw new AcquisitionError("RESOURCE_LIMIT", "Selected note images exceed the total byte limit.");
      const { response, signal } = await guardedFetch(imageUrl(page.url, true), "image", context);
      const body = await boundedBody(response, budget, signal);
      const extension = rasterExtension(body, (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase());
      let filename = path.join(directory, `page-${String(page.index).padStart(3, "0")}.${extension}`);
      await fs.writeFile(filename, body);
      context.signal.throwIfAborted();
      remainingTime(context);
      bytes += body.byteLength;
      let dimensions = { width: page.width, height: page.height };
      let retainedSize = body.byteLength;
      const retainedBudget = Math.min(IMAGE_LIMIT, TOTAL_IMAGE_LIMIT - retainedBytes);
      if (extension === "avif") {
        const png = path.join(directory, `page-${String(page.index).padStart(3, "0")}.png`);
        const normalized = await normalizeAvif(filename, png, retainedBudget, context);
        filename = png;
        dimensions = { width: normalized.width, height: normalized.height };
        retainedSize = normalized.bytes;
      }
      if (retainedSize > retainedBudget) throw new AcquisitionError("RESOURCE_LIMIT", "Normalized note images exceed the total byte limit.");
      retainedBytes += retainedSize;
      acquired.push({ index: page.index, path: filename, ...dimensions });
    }
    return { directory, pages: acquired, bytes, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    throw error;
  }
}
