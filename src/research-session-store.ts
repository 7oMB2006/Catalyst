import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { LongVideoRequest, LongVideoResult } from "./long-video-contracts.js";
import { longVideoResultSchema } from "./long-video-schema.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionName = (name: string) => name.endsWith(".json") && UUID.test(name.slice(0, -5));

export interface ResearchSessionRecord {
  schema_version: "1";
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  compatibility: string;
  request: LongVideoRequest;
  result: LongVideoResult;
}
export interface ResearchSessionSummary {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  title: string | null;
  status: "complete" | "partial" | "unavailable";
  overview_complete: boolean;
  completed_segments: number;
  total_segments: number;
}
export class ResearchSessionError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ResearchSessionError"; }
}

const qualitySchema = z.object({
  profile: z.enum(["standard", "high", "custom"]).optional(),
  resolution: z.enum(["720p", "1080p", "1440p", "2160p"]).optional(),
  fps: z.union([z.literal(30), z.literal(60)]).optional(),
  onUnavailable: z.enum(["error", "warn"]).optional(),
}).strict();
const requestSchema = z.object({
  url: z.string().min(1).max(8192), question: z.string().min(3),
  mode: z.enum(["language", "vision", "multimodal"]),
  mediaDetail: z.enum(["low", "default"]).optional(), includeComments: z.boolean().optional(),
  sourceQuality: qualitySchema.optional(), language: z.string().min(2).max(20).optional(),
  startSeconds: z.number().nonnegative().optional(), endSeconds: z.number().positive().optional(),
  timeoutSeconds: z.number().min(5).max(1800).optional(),
  segmentSeconds: z.number().int().min(120).max(900).optional(),
  maxSegments: z.number().int().min(1).max(24).optional(),
  maxDetailWindows: z.number().int().min(0).max(4).optional(),
  detailWindowSeconds: z.number().int().min(30).max(300).optional(),
  maxDownloadMB: z.number().int().min(32).max(2048).optional(),
  windowTimeoutSeconds: z.number().int().min(15).max(600).optional(),
}).strict().refine((request) => (request.startSeconds === undefined && request.endSeconds === undefined)
  || (request.startSeconds !== undefined && request.endSeconds !== undefined && request.endSeconds > request.startSeconds));
const recordSchema = z.object({
  schema_version: z.literal("1"), id: z.string().regex(UUID), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(), compatibility: z.string().min(1).max(1024),
  request: requestSchema, result: longVideoResultSchema.extend({ request: requestSchema }),
}).strict();

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function checkId(id: string): void {
  if (!UUID.test(id)) throw new ResearchSessionError("INVALID_SESSION_ID", "Supply a valid lowercase research session UUID.");
}
function parseRecord(input: unknown, id?: string): ResearchSessionRecord {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success || (id !== undefined && parsed.data.id !== id)) throw new ResearchSessionError("SESSION_CORRUPT", "The research session has an invalid or unsupported record format.");
  const record = parsed.data as ResearchSessionRecord;
  const metadata = record.result.session;
  if (metadata && (metadata.id !== record.id || metadata.revision !== record.revision || metadata.created_at !== record.created_at || metadata.updated_at !== record.updated_at)) {
    throw new ResearchSessionError("SESSION_CORRUPT", "The research session metadata does not match its record.");
  }
  return record;
}

/** Local result snapshots only: callers must remove credentials, signed URLs and media paths before saving. */
export class ResearchSessionStore {
  readonly directory: string;
  constructor(directory?: string) {
    this.directory = resolve(directory ?? process.env.CATALYST_SESSION_DIR ?? join(homedir(), ".catalyst", "sessions"));
  }
  newId(): string { return randomUUID(); }
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entry = await fs.lstat(this.directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ResearchSessionError("SESSION_IO_ERROR", "The session directory must be a real local directory.");
      if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
    } catch (error) {
      if (error instanceof ResearchSessionError) throw error;
      throw new ResearchSessionError("SESSION_IO_ERROR", "The research session directory is unavailable.");
    }
  }
  private async readLocal(path: string, limit: number): Promise<string> {
    // Check before and after opening, including on systems without O_NOFOLLOW.
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new ResearchSessionError("SESSION_CORRUPT", "The research session must be a regular local file.");
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new ResearchSessionError("SESSION_CORRUPT", "The research session changed while opening.");
      if (opened.size > limit) throw new ResearchSessionError("SESSION_TOO_LARGE", "The research session exceeds its file-size limit.");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
        if (total > limit) throw new ResearchSessionError("SESSION_TOO_LARGE", "The research session exceeds its file-size limit.");
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { await handle.close(); }
  }
  async load(id: string): Promise<ResearchSessionRecord> {
    checkId(id); await this.ensureDirectory();
    try { return parseRecord(JSON.parse(await this.readLocal(join(this.directory, `${id}.json`), MAX_BYTES)), id); }
    catch (error) {
      if (error instanceof ResearchSessionError) throw error;
      if (code(error) === "ENOENT") throw new ResearchSessionError("SESSION_NOT_FOUND", "The research session was not found.");
      if (error instanceof SyntaxError || code(error) === "ELOOP") throw new ResearchSessionError("SESSION_CORRUPT", "The research session is not readable JSON in a regular local file.");
      throw new ResearchSessionError("SESSION_IO_ERROR", "The research session could not be read.");
    }
  }
  private async lockOwner(path: string): Promise<{ pid: number; token: string } | null> {
    try {
      const value = JSON.parse(await this.readLocal(path, 1024)) as { pid?: unknown; token?: unknown };
      return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === "string" && UUID.test(value.token) ? { pid: Number(value.pid), token: value.token } : null;
    } catch { return null; }
  }
  private dead(pid: number): boolean {
    try { process.kill(pid, 0); return false; }
    catch (error) { return code(error) === "ESRCH"; }
  }
  private async recoverDeadLock(path: string): Promise<boolean> {
    // Serialize stale-lock removal so two recoverers cannot remove a new owner's lock.
    // An unreadable recovery guard is deliberately never stolen based on elapsed time.
    let guard: Awaited<ReturnType<typeof fs.open>>;
    const guardPath = `${path}.recovery`;
    try { guard = await fs.open(guardPath, "wx", 0o600); }
    catch (error) { if (code(error) === "EEXIST") return false; throw error; }
    try {
      const owner = await this.lockOwner(path);
      if (!owner || !this.dead(owner.pid)) return false;
      await fs.unlink(path); return true;
    } finally { await guard.close(); await fs.unlink(guardPath); }
  }
  private async fileLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const path = join(this.directory, name), token = randomUUID();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await fs.open(path, "wx", 0o600); break; }
      catch (error) {
        if (code(error) !== "EEXIST") throw new ResearchSessionError("SESSION_IO_ERROR", "The research session lock could not be created.");
        if (attempt === 0 && await this.recoverDeadLock(path)) continue;
        throw new ResearchSessionError("SESSION_BUSY", "The research session is in use by another operation. A lock without a verifiably dead owner requires manual inspection.");
      }
    }
    if (!handle) throw new ResearchSessionError("SESSION_BUSY", "The research session is in use.");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync();
      return await action();
    } finally {
      await handle.close();
      const owner = await this.lockOwner(path);
      if (owner?.pid === process.pid && owner.token === token) await fs.unlink(path);
    }
  }
  /** Hold this lock across load, work and every save. save() intentionally does not reacquire it. */
  async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    checkId(id); return this.fileLock(`${id}.lock`, action);
  }
  async save(record: ResearchSessionRecord, expectedRevision: number | null): Promise<void> {
    checkId(record.id); const parsed = parseRecord(record, record.id);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new ResearchSessionError("SESSION_CONFLICT", "Supply the previous positive session revision.");
    if (parsed.revision !== (expectedRevision ?? 0) + 1) throw new ResearchSessionError("SESSION_CONFLICT", "A saved session revision must advance by exactly one.");
    const content = JSON.stringify(parsed);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new ResearchSessionError("SESSION_TOO_LARGE", "The research session exceeds the 8 MiB local record limit.");
    await this.ensureDirectory();
    const save = async () => {
      let previous: ResearchSessionRecord | undefined;
      try { previous = await this.load(record.id); }
      catch (error) { if (!(error instanceof ResearchSessionError) || error.code !== "SESSION_NOT_FOUND") throw error; }
      if ((expectedRevision === null && previous) || (expectedRevision !== null && previous?.revision !== expectedRevision)) throw new ResearchSessionError("SESSION_CONFLICT", "The research session changed. Reload it before saving.");
      if (previous && previous.created_at !== parsed.created_at) throw new ResearchSessionError("SESSION_CONFLICT", "A research session's creation time cannot change.");
      if (!previous && (await fs.readdir(this.directory)).filter(sessionName).length >= MAX_SESSIONS) throw new ResearchSessionError("SESSION_LIMIT_REACHED", "The local store already contains 100 research sessions. Delete an old session before saving another.");
      const temporary = join(this.directory, `.${record.id}.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(content); await handle.sync(); await handle.close(); handle = undefined;
        await fs.rename(temporary, join(this.directory, `${record.id}.json`));
      } finally {
        if (handle) await handle.close();
        await fs.unlink(temporary).catch((error: unknown) => { if (code(error) !== "ENOENT") throw error; });
      }
    };
    try {
      // Different new sessions can be created concurrently; serialize the capacity check.
      if (expectedRevision === null) await this.fileLock("catalog.lock", save); else await save();
    } catch (error) {
      if (error instanceof ResearchSessionError) throw error;
      throw new ResearchSessionError("SESSION_IO_ERROR", "The research session could not be saved atomically.");
    }
  }
  async list(): Promise<ResearchSessionSummary[]> {
    await this.ensureDirectory();
    const output: ResearchSessionSummary[] = [];
    const names = (await fs.readdir(this.directory)).filter(sessionName).sort().slice(0, MAX_SESSIONS);
    for (const name of names) {
      let record: ResearchSessionRecord;
      try { record = await this.load(name.slice(0, -5)); }
      catch (error) {
        if (error instanceof ResearchSessionError && ["SESSION_CORRUPT", "SESSION_TOO_LARGE", "SESSION_NOT_FOUND"].includes(error.code)) continue;
        throw error;
      }
      output.push({ id: record.id, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at, title: record.result.video?.title ?? null, status: record.result.status, overview_complete: record.result.coverage.overview_complete, completed_segments: record.result.segments.filter((segment) => segment.status === "complete").length, total_segments: record.result.segments.length });
    }
    return output.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  }
  /** delete acquires its own lock; do not call it from inside withLock for the same ID. */
  async delete(id: string): Promise<void> {
    checkId(id);
    await this.withLock(id, async () => {
      const path = join(this.directory, `${id}.json`);
      try {
        const entry = await fs.lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new ResearchSessionError("SESSION_CORRUPT", "The research session must be a regular local file.");
        await fs.unlink(path);
      } catch (error) {
        if (error instanceof ResearchSessionError) throw error;
        if (code(error) === "ENOENT") throw new ResearchSessionError("SESSION_NOT_FOUND", "The research session was not found.");
        throw new ResearchSessionError("SESSION_IO_ERROR", "The research session could not be deleted.");
      }
    });
  }
}
