import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runProcess, ProcessExecutionError } from "../src/process.js";
import { AcquisitionError, runYtDlp } from "../src/acquisition.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function exists(filename: string): Promise<boolean> { return fs.access(filename).then(() => true, () => false); }

async function treeFixture(overflow = false) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "catalyst-process-tree-"));
  const ready = path.join(directory, "child-ready");
  const marker = path.join(directory, "orphan-marker");
  const parent = path.join(directory, "parent.cjs");
  const childScript = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'orphan survived'),1600);setInterval(()=>{},1000);`;
  await fs.writeFile(parent, `const fs=require('node:fs');const cp=require('node:child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});${overflow ? `const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(check);process.stdout.write('x'.repeat(100000));}},10);` : ""}setInterval(()=>{},1000);`);
  return {
    directory, ready, marker, parent,
    waitReady: async () => {
      const end = Date.now() + 5000;
      while (!await exists(ready) && Date.now() < end) await pause(10);
      assert.equal(await exists(ready), true, "fake downloader must spawn its child before cancellation");
    },
    cleanup: async () => {
      const pid = Number(await fs.readFile(ready, "utf8").catch(() => "0"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already terminated */ } }
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test("runProcess returns UTF-8 output and preserves executable-not-found errors", async () => {
  assert.deepEqual(await runProcess(process.execPath, ["-e", "process.stdout.write('字幕');process.stderr.write('diagnostic')"], { timeout: 3000, maxBuffer: 128 }), { stdout: "字幕", stderr: "diagnostic" });
  await assert.rejects(() => runProcess(path.join(tmpdir(), "catalyst-nonexistent-executable"), [], { timeout: 1000 }), (error: unknown) => error instanceof ProcessExecutionError && error.code === "ENOENT");
});

test("cancelling runYtDlp kills its TERM-resistant descendant even after parent exit", async () => {
  const fixture = await treeFixture();
  const controller = new AbortController();
  const keys = ["YTDLP_PATH", "YTDLP_PYTHON", "YOUTUBE_COOKIES_FILE", "YOUTUBE_COOKIES_FROM_BROWSER"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.YTDLP_PATH = fixture.parent;
  process.env.YTDLP_PYTHON = process.execPath;
  delete process.env.YOUTUBE_COOKIES_FILE;
  delete process.env.YOUTUBE_COOKIES_FROM_BROWSER;
  const pending = runYtDlp([], "youtube", { signal: controller.signal, deadlineMs: Date.now() + 10_000 });
  // Attach immediately so cancellation never creates an unhandled rejection.
  const outcome = pending.then(() => undefined, (error: unknown) => error);
  try {
    await fixture.waitReady();
    const started = Date.now();
    controller.abort();
    const error = await outcome;
    assert.ok(error instanceof AcquisitionError);
    assert.equal(error.code, "TIMEOUT");
    assert.ok(Date.now() - started < 6000, "tree teardown is bounded");
    await pause(1750);
    assert.equal(await exists(fixture.marker), false, "cancelled descendant must never write its delayed marker");
  } finally {
    controller.abort(); await outcome; await fixture.cleanup();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("a timeout terminates the whole downloader tree", async () => {
  const fixture = await treeFixture();
  const outcome = runProcess(process.execPath, [fixture.parent], { timeout: 1000, maxBuffer: 2048 }).then(() => undefined, (error: unknown) => error);
  try {
    await fixture.waitReady();
    const error = await outcome;
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.cleanupFailed, false);
    await pause(1750);
    assert.equal(await exists(fixture.marker), false, "timed-out descendant must not keep running");
  } finally { await outcome; await fixture.cleanup(); }
});

test("exceeding maxBuffer bounds retained bytes and terminates descendants", async () => {
  const fixture = await treeFixture(true);
  const outcome = runProcess(process.execPath, [fixture.parent], { timeout: 10_000, maxBuffer: 1024 }).then(() => undefined, (error: unknown) => error);
  try {
    await fixture.waitReady();
    const error = await outcome;
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.code, "MAX_BUFFER");
    assert.equal(error.cleanupFailed, false);
    assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 1024);
    await pause(1750);
    assert.equal(await exists(fixture.marker), false, "output-limited descendant must not keep running");
  } finally { await outcome; await fixture.cleanup(); }
});
