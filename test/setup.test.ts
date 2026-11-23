import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "dotenv";
import { startSetup } from "../src/setup/server.js";
import type { RunHost } from "../src/setup/hosts.js";

test("local setup saves shared settings without revealing keys or overwriting newer edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalyst setup "));
  const envFile = join(dir, ".env");
  const entry = join(dir, "index.js");
  const original = "# Retain this comment\r\nOTHER='untouched # text'\r\nGEMINI_API_KEY=old-private-key\r\n";
  await writeFile(envFile, original);
  await writeFile(entry, "");
  const commands: Parameters<RunHost>[] = [];
  const { url, server } = await startSetup({
    envFile, entry, node: process.execPath, env: {}, assets: new URL("../web/setup/", import.meta.url),
    runHost: async (...args) => {
      commands.push(args);
      return { code: 0, stdout: args[1].includes("list") ? "[]" : "" };
    },
    diagnose: async ({ env } = {}) => ({
      schema_version: "1.0", ok: env?.GEMINI_API_KEY === "old-private-key", checks: [], scope: "fixture",
    }),
  });
  try {
    const pageResponse = await fetch(url);
    const page = await pageResponse.text();
    assert.match(pageResponse.headers.get("content-security-policy") ?? "", /\bimg-src 'self';/);
    for (const name of ["gemini", "stepfun", "codex", "claude-code"]) {
      const icon = "icons/" + name + ".png";
      assert.ok(page.includes('src="./' + icon + '"'));
      const response = await fetch(url + "/" + icon);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL("../web/setup/" + icon, import.meta.url)));
    }
    const token = /content="([a-f0-9]{64})"/.exec(page)?.[1];
    assert.ok(token);
    assert.equal((await fetch(url + "/api/config")).status, 403);
    const api = (route: string, body?: object, overrides = {}) => fetch(url + "/api/" + route, body
      ? { method: "POST", headers: { "content-type": "application/json", "x-catalyst-setup": token, origin: url, ...overrides }, body: JSON.stringify(body) }
      : { headers: { "x-catalyst-setup": token, ...overrides } });
    const first = await api("config");
    const raw = await first.text();
    assert.equal(first.status, 200);
    assert.doesNotMatch(raw, /old-private-key/);
    const { revision, configured, launch } = JSON.parse(raw);
    assert.equal(configured.GEMINI_API_KEY, true);

    const settings = { revision, values: { CODEX_VIDEO_PROVIDER: "gemini", GEMINI_VIDEO_MODEL: "fixture-model", GEMINI_API_KEY: "", FFMPEG_PATH: join(dir, "has # space") } };
    assert.equal((await api("config", settings, { origin: "https://outside.invalid" })).status, 403);
    assert.equal((await api("config", settings, { "x-catalyst-setup": "wrong-token" })).status, 403);
    assert.equal(await readFile(envFile, "utf8"), original);
    const response = await api("config", settings);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /old-private-key/);
    const updated = await readFile(envFile, "utf8");
    assert.ok(updated.startsWith(original));
    assert.deepEqual(parse(updated), {
      ...parse(original), CODEX_VIDEO_PROVIDER: "gemini", GEMINI_VIDEO_MODEL: "fixture-model", FFMPEG_PATH: join(dir, "has # space"),
    });
    assert.equal((await api("config", settings)).status, 409);
    assert.equal(await readFile(envFile, "utf8"), updated);
    assert.equal((await (await api("doctor", {})).json()).ok, true);
    assert.equal((await api("hosts", { host: "other" })).status, 400);
    for (const host of ["codex", "claude"]) {
      assert.deepEqual(await (await api("hosts", { host })).json(), { status: "registered" });
    }
    assert.deepEqual(commands, [
      ["codex", ["mcp", "list", "--json"]],
      ["codex", ["mcp", "add", "catalyst", "--env", "DOTENV_CONFIG_PATH=" + envFile, "--", process.execPath, entry]],
      ["claude", ["mcp", "add-json", "--scope", "user", "catalyst", JSON.stringify(launch)]],
    ]);
    assert.doesNotMatch(JSON.stringify(commands), /old-private-key/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup refuses a conflicting Codex entry before calling add", async () => {
  const { launchConfig, registerHost } = await import("../src/setup/hosts.js");
  const launch = launchConfig(process.execPath, "/test/index.js", "/test/.env");
  const commands: string[][] = [];
  const run: RunHost = async (_host, args) => {
    commands.push(args);
    return { code: 0, stdout: JSON.stringify([{ name: "catalyst", transport: { ...launch, command: "/other/node" } }]) };
  };
  await assert.rejects(registerHost("codex", launch, run), /already has a different entry/);
  assert.deepEqual(commands, [["mcp", "list", "--json"]]);
});
