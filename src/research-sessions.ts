import { createHash } from "node:crypto";
import type { LongVideoDependencies, LongVideoRequest, LongVideoResult } from "./long-video-contracts.js";
import { researchLongVideo } from "./long-video.js";
import { ResearchSessionError, ResearchSessionStore, type ResearchSessionRecord } from "./research-session-store.js";
import { getConfiguredVideoProvider, redactSensitiveText } from "./video-analysis.js";

export interface SessionExecutionOptions {
  store?: ResearchSessionStore;
  dependencies?: Partial<LongVideoDependencies>;
  signal?: AbortSignal;
  saveSession?: boolean;
}
export interface ResumeResearchOptions {
  url?: string;
  timeoutSeconds?: number;
  windowTimeoutSeconds?: number;
  maxDownloadMB?: number;
}

/** Compatibility identifies processing semantics, never a credential or signed source URL. */
export function sessionCompatibility(): string {
  const provider = getConfiguredVideoProvider();
  return createHash("sha256").update(JSON.stringify({
    engine: "long-video-session-v1", provider,
    model: provider === "stepfun" ? process.env.STEPFUN_VIDEO_MODEL ?? "step-3.7-flash" : process.env.GEMINI_VIDEO_MODEL ?? "gemini-2.5-flash",
    asr: provider === "stepfun" ? process.env.STEPFUN_ASR_MODEL ?? "stepaudio-2.5-asr" : process.env.GEMINI_VIDEO_MODEL ?? "gemini-2.5-flash",
    endpoint: provider === "stepfun" ? (process.env.STEPFUN_BASE_URL?.trim() || "https://api.stepfun.com/v1").replace(/\/+$/, "") : "https://generativelanguage.googleapis.com",
  })).digest("hex");
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value); url.username = ""; url.password = ""; url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (!["p", "v"].includes(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return redactSensitiveText(value); }
}

/** A persisted snapshot contains research text and public identities, never acquisition inputs. */
export function sanitizeSessionResult(result: LongVideoResult): LongVideoResult {
  const visit = (value: unknown, key = ""): unknown => {
    if (/(?:api.?key|authorization|cookie|secret|password|token|signature|headers|media.?url|download.?url|path$|directory)/i.test(key)) return "[redacted]";
    if (typeof value === "string") return ["url", "sourceUrl", "canonicalUrl"].includes(key) ? safeUrl(redactSecrets(value)) : redactSensitiveText(value);
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    return value;
  };
  return visit(result) as LongVideoResult;
}
function redactSecrets(value: string): string {
  for (const [key, secret] of Object.entries(process.env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(key) && secret && secret.length > 5) value = value.split(secret).join("[redacted]");
  return value;
}

async function execute(request: LongVideoRequest, options: SessionExecutionOptions, saved?: ResearchSessionRecord): Promise<LongVideoResult> {
  if (options.saveSession === false && !saved) return researchLongVideo(request, options.dependencies, options.signal);
  const store = options.store ?? new ResearchSessionStore(), id = saved?.id ?? store.newId();
  return store.withLock(id, async () => {
    // Load under the operation lock so concurrent resumes cannot use a stale revision.
    const current = saved ? await store.load(id) : undefined;
    if (current && current.compatibility !== sessionCompatibility()) throw new ResearchSessionError("SESSION_INCOMPATIBLE", "The configured provider, model, ASR or engine changed. Start a new research session.");
    if (current) request = { ...current.request, ...request, url: request.url || current.request.url };
    let revision = current?.revision ?? 0;
    const created = current?.created_at ?? new Date().toISOString();
    const completed = new Set(current?.result.segments.filter((s) => s.status === "complete").map((s) => s.id) ?? []);
    let lastSaved: LongVideoResult["session"] = current?.result.session ?? null;
    const research = await researchLongVideo(request, options.dependencies, options.signal, {
      previous: current?.result,
      onCheckpoint: async (result) => {
        if (!result.video || !result.plan) return;
        const updated = new Date().toISOString();
        const info = { id, revision: revision + 1, created_at: created, updated_at: updated,
          reused_segments: completed.size,
          processed_segments: result.segments.filter((s) => !completed.has(s.id) && s.status !== "pending").length };
        const snapshot = sanitizeSessionResult({ ...result, session: info });
        const record: ResearchSessionRecord = { schema_version: "1", id, revision: revision + 1, created_at: created, updated_at: updated, compatibility: sessionCompatibility(), request: snapshot.request as LongVideoRequest, result: snapshot };
        await store.save(record, revision || null);
        revision++; result.session = info; lastSaved = info;
      },
    });
    // If saving failed, advertise only the last durable revision, never a non-existent checkpoint.
    research.session = lastSaved;
    return sanitizeSessionResult(research);
  });
}

export async function startLongVideoResearch(request: LongVideoRequest, options: SessionExecutionOptions = {}): Promise<LongVideoResult> {
  return execute(request, options);
}

export async function resumeLongVideoResearch(id: string, runtime: ResumeResearchOptions = {}, options: SessionExecutionOptions = {}): Promise<LongVideoResult> {
  const store = options.store ?? new ResearchSessionStore();
  const saved = await store.load(id);
  const request = { ...saved.request };
  // Only runtime budgets and a fresh access URL can be supplied. Question and research semantics stay fixed.
  if (runtime.url !== undefined) request.url = runtime.url;
  if (runtime.timeoutSeconds !== undefined) request.timeoutSeconds = runtime.timeoutSeconds;
  if (runtime.windowTimeoutSeconds !== undefined) request.windowTimeoutSeconds = runtime.windowTimeoutSeconds;
  if (runtime.maxDownloadMB !== undefined) request.maxDownloadMB = runtime.maxDownloadMB;
  return execute(request, { ...options, store }, saved);
}
