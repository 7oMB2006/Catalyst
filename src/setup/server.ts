import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { configEnvironment, configState, saveConfig, SetupError } from "./config.js";
import { launchConfig, registerHost, requireEntry, type RunHost } from "./hosts.js";
import { doctor } from "../doctor.js";

const LIMIT = 64 * 1024;
const staticFiles = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "icons/gemini.png": "image/png",
  "icons/stepfun.png": "image/png",
  "icons/codex.png": "image/png",
  "icons/claude-code.png": "image/png",
};
const guarded = new Set(["/api/config", "/api/doctor", "/api/hosts"]);

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

async function requestJson(req: IncomingMessage) {
  if (req.headers["content-type"] !== "application/json") throw new SetupError(415, "Send JSON.");
  if (Number(req.headers["content-length"]) > LIMIT) throw new SetupError(413, "Request is too large.");
  let total = 0;
  const buffers: Buffer[] = [];
  // Keep draining oversized requests so the client receives the error response.
  for await (const chunk of req) {
    total += chunk.length;
    if (total <= LIMIT) buffers.push(chunk);
  }
  if (total > LIMIT) throw new SetupError(413, "Request is too large.");
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(buffers).toString("utf8")); }
  catch { throw new SetupError(400, "Send valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SetupError(400, "Send a JSON object.");
  return value as Record<string, unknown>;
}

interface SetupOptions {
  envFile: string;
  node: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  runHost: RunHost;
  assets: URL;
  diagnose?: typeof doctor;
}

export async function startSetup(options: SetupOptions) {
  const { envFile, node, entry, env, runHost, assets, diagnose = doctor } = options;
  const token = randomBytes(32).toString("hex");
  const launch = launchConfig(node, entry, envFile);
  const files = new Map(await Promise.all(Object.entries(staticFiles).map(async ([name, type]) => {
    const data = await readFile(new URL(name, assets));
    const html = name === "index.html";
    const body = html ? data.toString("utf8").replace("__SETUP_TOKEN__", token) : data;
    return [html ? "/" : "/" + name, { type, body }] as const;
  })));
  let authority = "";
  let editing = false;
  let registering = false;
  let diagnosing = false;

  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const origin = "http://" + authority;
    if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || req.headers["sec-fetch-site"] === "cross-site") throw new SetupError(403, "Open the local setup URL printed in your terminal.");
    const url = req.url ?? "";
    const asset = files.get(url);
    if (req.method === "GET" && asset !== undefined) {
      res.writeHead(200, { "Content-Type": asset.type }).end(asset.body);
      return;
    }
    if (!guarded.has(url)) throw new SetupError(404, "Not found.");
    if (req.headers["x-catalyst-setup"] !== token || (req.method !== "GET" && req.headers.origin !== origin)) {
      throw new SetupError(403, "Reload the local setup page.");
    }
    if (url === "/api/config" && req.method === "GET") {
      json(res, 200, { ...await configState(envFile, env), envFile, launch });
      return;
    }
    if (req.method === "POST") {
      const body = await requestJson(req);
      if (url === "/api/config") {
        if (editing) throw new SetupError(409, "Another save is running. Reload the page.");
        editing = true;
        try {
          await saveConfig(envFile, body.revision, body.values);
          json(res, 200, { ...await configState(envFile, env), envFile, launch });
        } finally { editing = false; }
        return;
      }
      if (url === "/api/doctor") {
        if (diagnosing) throw new SetupError(409, "A local check is already running.");
        diagnosing = true;
        try { json(res, 200, await diagnose({ env: await configEnvironment(envFile, env) })); }
        finally { diagnosing = false; }
        return;
      }
      if (url === "/api/hosts") {
        if (registering) throw new SetupError(409, "A host registration is already running.");
        registering = true;
        try {
          await requireEntry(entry);
          const status = await registerHost(body.host, launch, runHost);
          json(res, 200, { status });
        } finally { registering = false; }
        return;
      }
    }
    throw new SetupError(405, "Method not allowed.");
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    void route(req, res).catch(error => {
      if (!res.headersSent) json(res, error instanceof SetupError ? error.status : 500, {
        error: error instanceof SetupError ? error.message : "The operation could not finish. Check local file and executable permissions.",
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  authority = "127.0.0.1:" + (server.address() as AddressInfo).port;
  return { url: "http://" + authority, server };
}
