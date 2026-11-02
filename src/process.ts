import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface ProcessOptions {
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  windowsHide?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class ProcessExecutionError extends Error {
  stdout = "";
  stderr = "";
  cleanupFailed = false;
  constructor(public code: string | number, message: string) { super(message); this.name = "ProcessExecutionError"; }
}

const TERM_GRACE_MS = 200;
const CLOSE_GRACE_MS = 1_000;
const WINDOWS_KILL_TIMEOUT_MS = 2_000;

/** Run a local cleanup command with its own bound, independent of the aborted request. */
function cleanupCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let killer: ChildProcess;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { killer?.kill("SIGKILL"); finish(false); }, WINDOWS_KILL_TIMEOUT_MS);
    try {
      killer = spawn(command, args, { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0));
    } catch { finish(false); }
  });
}

async function terminateWindowsTree(pid: number): Promise<boolean> {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
  if (await cleanupCommand(taskkill, ["/PID", String(pid), "/T", "/F"])) return true;
  // Get-CimInstance also finds children whose original parent exited between
  // cancellation and cleanup. Only the numeric process ID is interpolated.
  const script = `$all=@(Get-CimInstance Win32_Process -ErrorAction Stop);$todo=@(${pid});$ids=@();while($todo.Count -gt 0){$p=$todo[0];if($todo.Count -gt 1){$todo=@($todo[1..($todo.Count-1)])}else{$todo=@()};if($ids -notcontains $p){$ids+= $p;$todo+=@($all|Where-Object {$_.ParentProcessId -eq $p}|ForEach-Object {[int]$_.ProcessId})}};[array]::Reverse($ids);foreach($p in $ids){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}`;
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return cleanupCommand(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return true;
  try { process.kill(-child.pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    try { return child.kill(signal); } catch { return false; }
  }
}

/**
 * Bounded subprocess execution with group/tree cancellation. The request signal
 * is deliberately handled here rather than passed to spawn: killing the parent
 * first can orphan a downloader's FFmpeg processes before tree cleanup begins.
 * stdout and stderr share a byte limit; results never contain command arguments.
 */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new ProcessExecutionError("ABORT_ERR", "Process cancelled before launch.")); return; }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) { reject(new ProcessExecutionError("ETIMEDOUT", "Process deadline expired before launch.")); return; }
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) { reject(new ProcessExecutionError("INVALID_OPTIONS", "Process maxBuffer must be a positive integer.")); return; }
    let child: ChildProcess;
    let settled = false;
    let closed = false;
    let terminationDone = false;
    let stopReason: ProcessExecutionError | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled || (stopReason ? !terminationDone || !closed : !closed)) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(closeTimer);
      options.signal?.removeEventListener("abort", abort);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      const failure = stopReason ?? (exitCode === 0 ? undefined : new ProcessExecutionError(exitCode ?? "PROCESS_FAILED", `Process exited ${exitSignal ? `after ${exitSignal}` : `with code ${exitCode}`}.`));
      if (failure) { failure.stdout = out; failure.stderr = err; reject(failure); }
      else resolve({ stdout: out, stderr: err });
    };

    const stop = (reason: ProcessExecutionError) => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(deadlineTimer);
      const terminate = async () => {
        if (process.platform === "win32" && child.pid !== undefined) {
          const ok = await terminateWindowsTree(child.pid);
          if (!ok) { reason.cleanupFailed = true; try { child.kill("SIGKILL"); } catch { /* best effort after bounded tree-cleanup failure */ } }
        } else {
          const termOk = signalGroup(child, "SIGTERM");
          // Always retain escalation even if the parent closes early: a child
          // can ignore TERM and keep running with stdio redirected to a file.
          await new Promise<void>((done) => setTimeout(done, TERM_GRACE_MS));
          const killOk = signalGroup(child, "SIGKILL");
          reason.cleanupFailed = !termOk && !killOk;
        }
        terminationDone = true;
        if (!closed) {
          closeTimer = setTimeout(() => {
            // A cancelled command cannot indefinitely retain the caller through
            // inherited pipe handles. The tree kill has already been attempted.
            child.stdout?.destroy(); child.stderr?.destroy();
            child.unref(); closed = true; finish();
          }, CLOSE_GRACE_MS);
        }
        finish();
      };
      void terminate().catch(() => {
        reason.cleanupFailed = true; terminationDone = true;
        try { child.kill("SIGKILL"); } catch { /* reported through cleanupFailed */ }
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); closed = true; finish();
      });
    };
    const abort = () => stop(new ProcessExecutionError("ABORT_ERR", "Process cancelled; its subprocess tree was terminated."));
    const collect = (target: Buffer[], chunk: Buffer | string) => {
      if (stopReason || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBuffer - outputBytes);
      if (remaining) target.push(buffer.subarray(0, remaining));
      outputBytes += buffer.length;
      if (outputBytes > maxBuffer) stop(new ProcessExecutionError("MAX_BUFFER", "Process output exceeded maxBuffer; its subprocess tree was terminated."));
    };
    try {
      child = spawn(command, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: options.windowsHide ?? true, cwd: options.cwd, env: options.env });
    } catch (error) {
      reject(new ProcessExecutionError((error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED", "The configured executable could not be launched."));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (stopReason) return;
      stopReason = new ProcessExecutionError(error.code ?? "SPAWN_FAILED", "The configured executable could not be launched.");
      terminationDone = true; closed = true; finish();
    });
    child.once("close", (code, signal) => { closed = true; exitCode = code; exitSignal = signal; finish(); });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.timeout !== undefined && !stopReason) deadlineTimer = setTimeout(() => stop(new ProcessExecutionError("ETIMEDOUT", "Process timed out; its subprocess tree was terminated.")), Math.min(options.timeout, 2_147_483_647));
  });
}
