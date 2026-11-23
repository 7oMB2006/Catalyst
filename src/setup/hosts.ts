import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { SetupError } from "./config.js";

export function launchConfig(node: string, entry: string, file: string) {
  return { type: "stdio" as const, command: node, args: [entry], env: { DOTENV_CONFIG_PATH: file } };
}
type Launch = ReturnType<typeof launchConfig>;
export type RunHost = (host: "codex" | "claude", args: string[]) => Promise<{ code: number | string | null; stdout: string }>;

export function hostRunner(env: NodeJS.ProcessEnv, cwd: string): RunHost {
  return (host, args) => new Promise(resolve => {
    // Native executables on PATH. No shell and no browser-supplied commands.
    execFile(process.platform === "win32" ? host + ".exe" : host, args, {
      env, cwd, timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true,
    }, (error, stdout) => resolve({ code: error ? error.code ?? null : 0, stdout }));
  });
}

function ensureHost(result: Awaited<ReturnType<RunHost>>, host: string) {
  if (result.code === "ENOENT") throw new SetupError(404, host + " CLI is not on PATH. Install it or copy the configuration below.");
  if (result.code !== 0) throw new SetupError(409, host + " did not save the entry. Check its CLI and any existing Catalyst entry.");
}

export async function registerHost(host: unknown, launch: Launch, run: RunHost) {
  if (host !== "codex" && host !== "claude") throw new SetupError(400, "Choose a supported host.");
  if (host === "codex") {
    const result = await run(host, ["mcp", "list", "--json"]);
    ensureHost(result, "Codex");
    let servers: unknown;
    try { servers = JSON.parse(result.stdout); } catch { /* Report a format issue without returning output. */ }
    if (!Array.isArray(servers)) throw new SetupError(409, "Codex did not return a readable MCP list.");
    const existing = servers.find(entry => entry?.name === "catalyst");
    if (existing) {
      const current = existing.transport;
      if (existing.enabled !== false && current?.type === "stdio" && current.command === launch.command
        && JSON.stringify(current.args) === JSON.stringify(launch.args)
        && Object.keys(current.env ?? {}).length === 1 && current.env.DOTENV_CONFIG_PATH === launch.env.DOTENV_CONFIG_PATH
        && !current.env_vars?.length) return "already-registered";
      throw new SetupError(409, "Codex already has a different entry named catalyst. Review that entry in Codex first.");
    }
    ensureHost(await run(host, [
      "mcp", "add", "catalyst", "--env", "DOTENV_CONFIG_PATH=" + launch.env.DOTENV_CONFIG_PATH, "--", launch.command, ...launch.args,
    ]), "Codex");
  } else {
    // Claude Code rejects a duplicate server name in the selected scope.
    ensureHost(await run(host, ["mcp", "add-json", "--scope", "user", "catalyst", JSON.stringify(launch)]), "Claude Code");
  }
  return "registered";
}

export async function requireEntry(entry: string) {
  try { await access(entry); }
  catch { throw new SetupError(409, "Build Catalyst with npm run build before connecting a host."); }
}
