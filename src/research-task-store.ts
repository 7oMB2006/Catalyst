import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResearchTaskRecord, ResearchTaskStorage } from "./research-task-contracts.js";
import { parseResearchTaskRecord } from "./research-task-schema.js";
import { sanitizeResearchSnapshot } from "./research-sessions.js";

const MAX_BYTES = 8 * 1024 * 1024, MAX_TASKS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const taskName = (name: string) => name.endsWith(".json") && UUID.test(name.slice(0, -5));
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

export class ResearchTaskError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ResearchTaskError"; }
}
function checkId(id: string): void {
  if (!UUID.test(id)) throw new ResearchTaskError("INVALID_TASK_ID", "Supply a valid lowercase research task UUID.");
}
export interface TaskSnapshot { id: string; revision: number; created_at: string; updated_at: string }

/** Private, bounded snapshots. Hold withLock across load, external work and each save. */
export class SnapshotTaskStore<T extends TaskSnapshot> {
  readonly directory: string;
  constructor(directory: string | undefined, private readonly parse: (input: unknown, id?: string) => T) {
    this.directory = resolve(directory ?? process.env.CATALYST_TASK_DIR ?? join(homedir(), ".catalyst", "tasks"));
  }
  private parseRecord(input: unknown, id: string): T {
    try { return this.parse(input, id); }
    catch { throw new ResearchTaskError("TASK_CORRUPT", "The research task has an invalid or unsupported record format."); }
  }
  newId(): string { return randomUUID(); }
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entry = await fs.lstat(this.directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ResearchTaskError("TASK_IO_ERROR", "The task directory must be a real local directory.");
      if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
    } catch (error) {
      if (error instanceof ResearchTaskError) throw error;
      throw new ResearchTaskError("TASK_IO_ERROR", "The research task directory is unavailable.");
    }
  }
  private async readLocal(path: string, limit: number): Promise<string> {
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new ResearchTaskError("TASK_CORRUPT", "The research task must be a regular local file.");
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new ResearchTaskError("TASK_CORRUPT", "The research task changed while opening.");
      if (opened.size > limit) throw new ResearchTaskError("TASK_TOO_LARGE", "The research task exceeds its file-size limit.");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
        if (total > limit) throw new ResearchTaskError("TASK_TOO_LARGE", "The research task exceeds its file-size limit.");
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { await handle.close(); }
  }
  async load(id: string): Promise<T> {
    checkId(id); await this.ensureDirectory();
    try { return this.parseRecord(JSON.parse(await this.readLocal(join(this.directory, `${id}.json`), MAX_BYTES)), id); }
    catch (error) {
      if (error instanceof ResearchTaskError) throw error;
      if (code(error) === "ENOENT") throw new ResearchTaskError("TASK_NOT_FOUND", "The research task was not found.");
      if (error instanceof SyntaxError || code(error) === "ELOOP") throw new ResearchTaskError("TASK_CORRUPT", "The research task is not readable JSON in a regular local file.");
      throw new ResearchTaskError("TASK_IO_ERROR", "The research task could not be read.");
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
    // A guard prevents concurrent recoverers from unlinking a new owner's lock.
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
  private async fileLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const path = join(this.directory, name), token = randomUUID();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await fs.open(path, "wx", 0o600); break; }
      catch (error) {
        if (code(error) !== "EEXIST") throw new ResearchTaskError("TASK_IO_ERROR", "The research task lock could not be created.");
        if (attempt === 0 && await this.recoverDeadLock(path)) continue;
        throw new ResearchTaskError("TASK_BUSY", "The research task is in use. A lock without a verifiably dead owner requires manual inspection.");
      }
    }
    if (!handle) throw new ResearchTaskError("TASK_BUSY", "The research task is in use.");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      const owner = await this.lockOwner(path);
      if (owner?.pid === process.pid && owner.token === token) await fs.unlink(path);
    }
  }
  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    checkId(id); return this.fileLock(`${id}.lock`, operation);
  }
  /** save does not reacquire the task lock; the caller holds it through the operation. */
  async save(record: T, expectedRevision: number | null): Promise<void> {
    checkId(record.id);
    let sanitized: unknown;
    try { sanitized = sanitizeResearchSnapshot(record); }
    catch { throw new ResearchTaskError("TASK_CORRUPT", "The research task is not a serializable snapshot."); }
    const parsed = this.parseRecord(sanitized, record.id);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new ResearchTaskError("TASK_CONFLICT", "Supply the previous positive task revision.");
    if (parsed.revision !== (expectedRevision ?? 0) + 1) throw new ResearchTaskError("TASK_CONFLICT", "A saved task revision must advance by exactly one.");
    let content: string;
    try { content = JSON.stringify(parsed); }
    catch { throw new ResearchTaskError("TASK_CORRUPT", "The research task is not a serializable snapshot."); }
    if (Buffer.byteLength(content) > MAX_BYTES) throw new ResearchTaskError("TASK_TOO_LARGE", "The research task exceeds the 8 MiB local record limit.");
    await this.ensureDirectory();
    const save = async () => {
      let previous: T | undefined;
      try { previous = await this.load(record.id); }
      catch (error) { if (!(error instanceof ResearchTaskError) || error.code !== "TASK_NOT_FOUND") throw error; }
      if ((expectedRevision === null && previous) || (expectedRevision !== null && previous?.revision !== expectedRevision)) throw new ResearchTaskError("TASK_CONFLICT", "The research task changed. Reload it before saving.");
      if (previous && previous.created_at !== parsed.created_at) throw new ResearchTaskError("TASK_CONFLICT", "A research task's creation time cannot change.");
      if (!previous && (await fs.readdir(this.directory)).filter(taskName).length >= MAX_TASKS) throw new ResearchTaskError("TASK_LIMIT_REACHED", "The local store already contains 100 research tasks. Delete an old task before saving another.");
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
      if (expectedRevision === null) await this.fileLock("catalog.lock", save); else await save();
    } catch (error) {
      if (error instanceof ResearchTaskError) throw error;
      throw new ResearchTaskError("TASK_IO_ERROR", "The research task could not be saved atomically.");
    }
  }
  async list(): Promise<T[]> {
    await this.ensureDirectory();
    const output: T[] = [];
    const names = (await fs.readdir(this.directory)).filter(taskName).sort().slice(0, MAX_TASKS);
    for (const name of names) {
      try { output.push(await this.load(name.slice(0, -5))); }
      catch (error) {
        if (error instanceof ResearchTaskError && ["TASK_CORRUPT", "TASK_TOO_LARGE", "TASK_NOT_FOUND"].includes(error.code)) continue;
        throw error;
      }
    }
    return output.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  }
  /** delete acquires its own lock; do not call inside withLock for the same task. */
  async delete(id: string): Promise<void> {
    checkId(id);
    await this.withLock(id, async () => {
      const path = join(this.directory, `${id}.json`);
      try {
        const entry = await fs.lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new ResearchTaskError("TASK_CORRUPT", "The research task must be a regular local file.");
        await fs.unlink(path);
      } catch (error) {
        if (error instanceof ResearchTaskError) throw error;
        if (code(error) === "ENOENT") throw new ResearchTaskError("TASK_NOT_FOUND", "The research task was not found.");
        throw new ResearchTaskError("TASK_IO_ERROR", "The research task could not be deleted.");
      }
    });
  }
}

/** The original immutable follow-up task format remains unchanged. */
export class ResearchTaskStore extends SnapshotTaskStore<ResearchTaskRecord> implements ResearchTaskStorage {
  constructor(directory?: string) { super(directory, parseResearchTaskRecord); }
}
