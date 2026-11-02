import test from "node:test";
import assert from "node:assert/strict";
import { doctor, probeVersion, type VersionProbe } from "../src/doctor.js";

async function healthyProbe(command: string, args: string[]): Promise<VersionProbe> {
  if (command === "/fixtures/python" && args.length === 1 && args[0] === "--version") return { ok: true, stdout: "Python 3.14.7" };
  if (args.includes("-c")) return { ok: true, stdout: "present" };
  if (args.includes("-version")) return { ok: true, stdout: "ffmpeg version 9.0-test\nfixture" };
  return { ok: true, stdout: "2026.10.26" };
}

test("doctor distinguishes dependency failure from configured provider and never emits its credential", async () => {
  const secret = "doctor-fixture-secret-must-not-appear";
  const report = await doctor({
    nodeVersion: "26.0.0",
    env: { CODEX_VIDEO_PROVIDER: "stepfun", STEPFUN_API_KEY: secret, FFMPEG_PATH: "/fixtures/ffmpeg", YTDLP_PATH: "/fixtures/yt-dlp", YTDLP_PYTHON: "/fixtures/python" },
    run: async (command, args) => command === "/fixtures/python" ? { ok: false, stdout: "" } : healthyProbe(command, args),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "provider")?.code, "PROVIDER_CONFIGURED");
  assert.equal(report.checks.find((check) => check.id === "yt_dlp")?.code, "YTDLP_UNAVAILABLE");
  assert.match(report.checks.find((check) => check.id === "yt_dlp")?.hint ?? "", /Python >=3.10/);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("doctor checks the selected Python environment for EJS without extracting a URL", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const report = await doctor({
    nodeVersion: "24.0.0",
    env: { STEPFUN_API_KEY: "fixture", FFMPEG_PATH: "/fixtures/ffmpeg", YTDLP_PATH: "/fixtures/yt-dlp", YTDLP_PYTHON: "/fixtures/python" },
    run: async (command, args) => { calls.push({ command, args }); return healthyProbe(command, args); },
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === "ejs")?.code, "EJS_PRESENT");
  assert.ok(calls.some((call) => call.command === "/fixtures/python" && call.args[0] === "-c"));
  assert.ok(calls.every((call) => call.args.every((argument) => !/^https?:/.test(argument))));
});

test("doctor reports a placeholder credential and old Node as unavailable", async () => {
  const report = await doctor({
    nodeVersion: "22.1.0",
    env: { CODEX_VIDEO_PROVIDER: "gemini", GEMINI_API_KEY: "${GEMINI_API_KEY}", FFMPEG_PATH: "/fixtures/ffmpeg", YTDLP_PATH: "/fixtures/yt-dlp" },
    run: healthyProbe,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "node")?.code, "NODE_UNSUPPORTED");
  assert.equal(report.checks.find((check) => check.id === "provider")?.code, "PROVIDER_CREDENTIAL_MISSING");
  assert.equal(report.checks.find((check) => check.id === "ejs")?.status, "warning");
});

test("local version probes have a deadline and do not expose child stderr", async () => {
  const success = await probeVersion(process.execPath, ["-e", "console.log('fixture-version')"]);
  assert.deepEqual(success, { ok: true, stdout: "fixture-version" });
  const timeout = await probeVersion(process.execPath, ["-e", "console.error('private diagnostic');setInterval(()=>{},1000)"], 30);
  assert.deepEqual(timeout, { ok: false, stdout: "" });
});
