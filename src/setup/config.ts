import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";

const fields = [
  "CODEX_VIDEO_PROVIDER", "GEMINI_VIDEO_MODEL", "STEPFUN_VIDEO_MODEL", "STEPFUN_ASR_MODEL", "STEPFUN_BASE_URL",
  "FFMPEG_PATH", "YTDLP_PATH", "YTDLP_PYTHON",
] as const;
const secrets = ["GEMINI_API_KEY", "STEPFUN_API_KEY"] as const;
type Setting = (typeof fields)[number] | (typeof secrets)[number];

export class SetupError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function readConfig(file: string) {
  let source: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 256 * 1024) throw new SetupError(422, "Select a regular .env file smaller than 256 KiB.");
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = "";
  }
  return { source, values: parse(source), revision: createHash("sha256").update(source).digest("hex") };
}

export async function configState(file: string, env: NodeJS.ProcessEnv) {
  const { revision, values } = await readConfig(file);
  return {
    revision,
    values: Object.fromEntries(fields.map(key => [key, values[key] ?? ""])),
    configured: Object.fromEntries(secrets.map(key => [key, Boolean((env[key] ?? values[key])?.trim())])),
    overrides: [...fields, ...secrets].filter(key => env[key] !== undefined),
  };
}

export async function configEnvironment(file: string, env: NodeJS.ProcessEnv) {
  return { ...(await readConfig(file)).values, ...env };
}

function assignment(key: Setting, value: string): string {
  for (const quote of ["'", "\"", "`", ""]) {
    const line = key + "=" + quote + value + quote;
    if (parse(line)[key] === value) return line;
  }
  throw new SetupError(422, "Cannot represent " + key + " as a single-line .env value.");
}

export async function saveConfig(file: string, revision: unknown, values: unknown) {
  if (typeof revision !== "string" || !values || typeof values !== "object" || Array.isArray(values)) {
    throw new SetupError(400, "Send a configuration revision and settings.");
  }
  const updates = new Map<Setting, string>();
  for (const [name, value] of Object.entries(values)) {
    const key = name as Setting;
    if (![...fields, ...secrets].includes(key) || typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096) {
      throw new SetupError(422, "Send only supported single-line settings.");
    }
    if (key === "CODEX_VIDEO_PROVIDER" && !["gemini", "stepfun"].includes(value)) {
      throw new SetupError(422, "Choose Gemini or StepFun.");
    }
    if (key === "STEPFUN_BASE_URL" && value) {
      let url: URL;
      try { url = new URL(value); }
      catch { throw new SetupError(422, "Enter a valid StepFun API URL."); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new SetupError(422, "Use an HTTPS StepFun API URL without credentials or query parameters.");
      }
    }
    if (!(secrets as readonly string[]).includes(key) || value) updates.set(key, value);
  }
  const old = await readConfig(file);
  if (revision !== old.revision) throw new SetupError(409, "The file changed. Reload the page before saving again.");
  const expected = { ...old.values };
  for (const [key, value] of updates) {
    if (!value) delete expected[key];
    else expected[key] = value;
  }
  const eol = old.source.includes("\r\n") ? "\r\n" : "\n";
  const retained = old.source.split(/(?<=\n)/).filter(line => {
    const key = /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=|:[ \t])/.exec(line)?.[1] as Setting | undefined;
    if (!key || !updates.has(key)) return true;
    // A multiline assignment cannot be edited as a line. The full-file parse
    // below must also agree with our edit, including all unrelated settings.
    const standalone = parse(line)[key];
    const tail = /^[ \t]*(?:export[ \t]+)?[\w.-]+[ \t]*(?:=|:[ \t])[ \t]*(['"`])/.exec(line)?.[1];
    if (tail && !line.trimEnd().slice(line.indexOf(tail) + 1).includes(tail)) {
      throw new SetupError(422, "Edit the multiline " + key + " setting in the file directly.");
    }
    return standalone === undefined;
  }).join("");
  const patch = [...updates].filter(([, value]) => value).map(([key, value]) => assignment(key, value));
  const next = patch.length ? retained + (retained && !retained.endsWith("\n") ? eol : "") + patch.join(eol) + eol : retained;
  if (Buffer.byteLength(next) > 256 * 1024) throw new SetupError(422, "The settings file would exceed 256 KiB.");
  const roundTrip = parse(next);
  if (Object.keys(roundTrip).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => roundTrip[key] !== value)) {
    throw new SetupError(422, "Cannot update this .env layout without affecting other settings.");
  }
  if (next === old.source) return;
  const tmp = path.join(path.dirname(file), ".catalyst-setup-" + randomUUID() + ".tmp");
  try {
    await writeFile(tmp, next, { flag: "wx", mode: 0o600 });
    if ((await readConfig(file)).revision !== revision) throw new SetupError(409, "The file changed. Reload the page before saving again.");
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
