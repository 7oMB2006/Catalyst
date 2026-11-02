import "dotenv/config";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectDownloader } from "./acquisition.js";

const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;

export interface DoctorCheck {
  id: "node" | "python" | "ffmpeg" | "yt_dlp" | "ejs" | "provider";
  status: "ok" | "warning" | "error";
  code: string;
  message: string;
  executable?: string;
  version?: string;
  hint?: string;
}

export interface DoctorReport {
  schema_version: "1.0";
  ok: boolean;
  checks: DoctorCheck[];
  scope: string;
}

export interface VersionProbe {
  ok: boolean;
  stdout: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  run?: (command: string, args: string[], timeoutMs: number) => Promise<VersionProbe>;
}

/** Execute only local version/import probes. Diagnostic stderr is never returned. */
export function probeVersion(command: string, args: string[], timeoutMs = 5_000): Promise<VersionProbe> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: error ? "" : String(stdout).trim() });
    });
  });
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? "";
}

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim()) && !/^\$\{[^}]+\}$/.test(value!.trim());
}

async function detectEjs(command: string, prefixArgs: string[], run: NonNullable<DoctorOptions["run"]>): Promise<DoctorCheck> {
  // A configured Python runner allows checking its packages and a zipapp's bundled
  // modules. For a standalone executable there is no reliable offline package API.
  if (prefixArgs.length) {
    const archive = prefixArgs[0] === "-m" ? "" : prefixArgs[0];
    const result = await run(command, ["-c", "import importlib.util,sys;sys.path.insert(0,sys.argv[1]);print('present' if importlib.util.find_spec('yt_dlp_ejs') else 'absent')", archive], 5_000);
    if (result.ok && result.stdout.trim() === "present") {
      return { id: "ejs", status: "ok", code: "EJS_PRESENT", message: "EJS is importable by the selected downloader runtime. YouTube commands explicitly enable the current Node runtime." };
    }
    if (result.ok && result.stdout.trim() === "absent") {
      return { id: "ejs", status: "warning", code: "EJS_NOT_FOUND", message: "EJS was not found in the selected Python runtime or downloader archive.", hint: "Install yt-dlp[default] in that Python environment, or select an official standalone yt-dlp distribution that includes EJS." };
    }
  }
  return { id: "ejs", status: "warning", code: "EJS_UNCONFIRMED", message: "Offline checks cannot confirm EJS for this downloader installation. YouTube challenge solving has not been tested.", hint: "Use an official yt-dlp distribution with EJS; then verify a public YouTube sample. Node is explicitly enabled by Catalyst's YouTube acquisition path." };
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const run = options.run ?? probeVersion;
  const version = options.nodeVersion ?? process.versions.node;
  const checks: DoctorCheck[] = [];
  checks.push(Number(version.split(".")[0]) >= 24
    ? { id: "node", status: "ok", code: "NODE_SUPPORTED", message: "Node.js meets Catalyst's minimum version.", executable: process.execPath, version }
    : { id: "node", status: "error", code: "NODE_UNSUPPORTED", message: "Catalyst requires Node.js 24 or newer.", version, hint: "Select Node.js >=24 before installing or starting Catalyst." });

  const ffmpeg = env.FFMPEG_PATH?.trim() || ffmpegStatic;
  if (!ffmpeg) {
    checks.push({ id: "ffmpeg", status: "error", code: "FFMPEG_MISSING", message: "No FFmpeg executable is configured.", hint: "Install FFmpeg and set FFMPEG_PATH to its executable, or restore the ffmpeg-static binary." });
  } else {
    const result = await run(ffmpeg, ["-version"], 5_000);
    checks.push(result.ok && /^ffmpeg version\s/i.test(result.stdout)
      ? { id: "ffmpeg", status: "ok", code: "FFMPEG_AVAILABLE", message: "FFmpeg can be executed.", executable: ffmpeg, version: firstLine(result.stdout) }
      : { id: "ffmpeg", status: "error", code: "FFMPEG_UNAVAILABLE", message: "The selected FFmpeg executable did not respond with a version.", executable: ffmpeg, hint: "Check FFMPEG_PATH, file permissions and the executable's platform/architecture." });
  }

  try {
    const downloader = inspectDownloader(env);
    if (downloader.prefixArgs.length) {
      const python = await run(downloader.command, ["--version"], 5_000);
      const parts = /^Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(python.stdout.trim());
      const supported = Boolean(python.ok && parts && (Number(parts[1]) > 3 || Number(parts[1]) === 3 && Number(parts[2]) >= 10));
      checks.push(supported
        ? { id: "python", status: "ok", code: "PYTHON_SUPPORTED", message: "The explicitly selected Python meets the downloader minimum.", executable: downloader.command, version: parts![0] }
        : { id: "python", status: "error", code: "PYTHON_UNSUPPORTED", message: "The explicitly selected downloader runner is not an available Python >=3.10.", executable: downloader.command, hint: "Set YTDLP_PYTHON to a supported Python interpreter, or omit it for a standalone yt-dlp executable." });
    }
    const result = await run(downloader.command, [...downloader.prefixArgs, "--ignore-config", "--version"], 5_000);
    const downloaderVersion = firstLine(result.stdout);
    checks.push(result.ok && /^\d{4}\.\d{2}\.\d{2}(?:[.\w+-]*)?$/.test(downloaderVersion)
      ? { id: "yt_dlp", status: "ok", code: "YTDLP_AVAILABLE", message: "yt-dlp can be executed with the selected runtime.", executable: downloader.command, version: downloaderVersion }
      : { id: "yt_dlp", status: "error", code: "YTDLP_UNAVAILABLE", message: "The selected yt-dlp executable or Python runner did not respond with a version.", executable: downloader.command, hint: "Set YTDLP_PATH to yt-dlp. For a Python launcher/archive, set YTDLP_PYTHON to Python >=3.10; system Python may be too old." });
    checks.push(await detectEjs(downloader.command, downloader.prefixArgs, run));
  } catch {
    checks.push({ id: "yt_dlp", status: "error", code: "YTDLP_MISSING", message: "The bundled downloader could not be located.", hint: "Run npm ci, or set YTDLP_PATH and, when needed, YTDLP_PYTHON." });
    checks.push({ id: "ejs", status: "warning", code: "EJS_UNCONFIRMED", message: "EJS could not be checked because no downloader was found." });
  }

  const provider = (env.CODEX_VIDEO_PROVIDER ?? "stepfun").trim().toLowerCase();
  if (!["stepfun", "gemini"].includes(provider)) {
    checks.push({ id: "provider", status: "error", code: "PROVIDER_UNSUPPORTED", message: "CODEX_VIDEO_PROVIDER must be stepfun or gemini.", hint: "Choose a supported provider in the environment or .env file." });
  } else {
    const present = configured(provider === "stepfun" ? env.STEPFUN_API_KEY : env.GEMINI_API_KEY);
    checks.push(present
      ? { id: "provider", status: "ok", code: "PROVIDER_CONFIGURED", message: `${provider} credentials are configured; API access and balance were not tested.` }
      : { id: "provider", status: "error", code: "PROVIDER_CREDENTIAL_MISSING", message: `${provider} credentials are not configured.`, hint: `Set ${provider === "stepfun" ? "STEPFUN_API_KEY" : "GEMINI_API_KEY"} in the environment or local .env; keep credentials out of client configuration files.` });
  }

  return { schema_version: "1.0", ok: !checks.some((check) => check.status === "error"), checks, scope: "Local dependency/version checks and credential presence only. No browser cookies, platform requests or provider requests are used." };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  doctor().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }).catch(() => {
    process.stderr.write("Catalyst doctor could not complete its local checks.\n");
    process.exitCode = 1;
  });
}
