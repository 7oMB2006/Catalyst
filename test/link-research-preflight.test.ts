import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LongVideoResult } from "../src/long-video-contracts.js";
import { startLinkResearchTask, continueLinkResearchTask } from "../src/link-research.js";
import { engineHost, MemoryLinkResearchStore, QUESTION, VIDEO_ONE } from "./helpers/link-research-fixtures.js";

async function fixture(work: (value: ReturnType<typeof engineHost> & { store: MemoryLinkResearchStore; sessionPath: string; initial: Awaited<ReturnType<typeof startLinkResearchTask>>; requests: () => number }) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst link preflight "));
  const sessionDirectory = join(directory, "sessions");
  const before = { provider: process.env.CODEX_VIDEO_PROVIDER, model: process.env.STEPFUN_VIDEO_MODEL, directory: process.env.CATALYST_SESSION_DIR };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Local resume preflight must not request a source or provider."); };
  process.env.CODEX_VIDEO_PROVIDER = "stepfun";
  process.env.STEPFUN_VIDEO_MODEL = "preflight-original-model";
  process.env.CATALYST_SESSION_DIR = sessionDirectory;
  try {
    const engine = engineHost(sessionDirectory), store = new MemoryLinkResearchStore();
    engine.settings.duration = 240;
    engine.settings.failWindow = (_url, start) => start === 120;
    const initial = await startLinkResearchTask({ urls: [VIDEO_ONE], question: QUESTION, mode: "language", segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0, actionTimeoutSeconds: 60, totalTimeoutSeconds: 900 }, { host: engine.host, store });
    assert.equal(initial.task.status, "partial");
    const result = initial.task.actions[0].result as unknown as LongVideoResult;
    assert.ok(result.session);
    await work({ ...engine, store, initial, sessionPath: join(sessionDirectory, `${result.session.id}.json`), requests: () => requests });
  } finally {
    for (const [key, value] of [["CODEX_VIDEO_PROVIDER", before.provider], ["STEPFUN_VIDEO_MODEL", before.model], ["CATALYST_SESSION_DIR", before.directory]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a changed local provider model refuses resume before dispatch and remains resumable after restoring configuration", async () => fixture(async ({ initial, store, host, settings, calls, windows, sessionPath, requests }) => {
  const receipt = structuredClone(initial.task.actions[0]), budget = structuredClone(initial.task.budget);
  const sessionBefore = await fs.readFile(sessionPath, "utf8");
  process.env.STEPFUN_VIDEO_MODEL = "preflight-changed-model";
  const stopped = await continueLinkResearchTask(initial.task.id, {}, { store });
  assert.equal(stopped.task.status, "needs_attention"); assert.equal(stopped.task.stop_reason, "session_incompatible");
  assert.deepEqual(stopped.task.actions, [receipt]); assert.deepEqual(stopped.task.budget, budget);
  assert.equal(calls.length, 1); assert.equal(requests(), 0);
  assert.equal(await fs.readFile(sessionPath, "utf8"), sessionBefore);
  const again = await continueLinkResearchTask(initial.task.id, {}, { store });
  assert.deepEqual(again, stopped, "an unchanged local refusal does not churn the task revision");
  process.env.STEPFUN_VIDEO_MODEL = "preflight-original-model";
  settings.failWindow = () => false;
  const resumed = await continueLinkResearchTask(initial.task.id, { maxSteps: 1 }, { store, host });
  assert.equal(resumed.task.status, "completed"); assert.equal(resumed.task.actions.length, 2);
  assert.deepEqual(resumed.task.actions[0], receipt); assert.equal(resumed.task.actions[1].state, "recorded");
  assert.equal(resumed.task.budget.reserved_timeout_seconds, budget.reserved_timeout_seconds + 60);
  assert.deepEqual(windows.map(w => [w.start, w.end]), [[0, 120], [120, 240], [120, 240]]);
  assert.deepEqual(calls.map(c => c.name), ["analyze_long_video_url", "resume_long_video_research"]);
  assert.equal(requests(), 0);
}));

test("invalid local provider configuration is a pre-dispatch refusal rather than an unknown action", async () => fixture(async ({ initial, store, requests }) => {
  process.env.CODEX_VIDEO_PROVIDER = "unsupported-preflight-provider";
  const stopped = await continueLinkResearchTask(initial.task.id, {}, { store });
  assert.equal(stopped.task.status, "needs_attention"); assert.equal(stopped.task.stop_reason, "session_incompatible");
  assert.deepEqual(stopped.task.actions, initial.task.actions); assert.deepEqual(stopped.task.budget, initial.task.budget);
  assert.equal(requests(), 0);
}));

for (const failure of ["missing", "corrupt"] as const) {
  test(`a ${failure} local session refuses resume without reserving another action`, async () => fixture(async ({ initial, store, sessionPath, requests }) => {
    if (failure === "missing") await fs.unlink(sessionPath); else await fs.writeFile(sessionPath, "{invalid local session");
    const stopped = await continueLinkResearchTask(initial.task.id, {}, { store });
    assert.equal(stopped.task.status, "needs_attention"); assert.equal(stopped.task.stop_reason, "session_unavailable");
    assert.deepEqual(stopped.task.actions, initial.task.actions); assert.deepEqual(stopped.task.budget, initial.task.budget);
    assert.equal(requests(), 0);
  }));
}

test("an injected host retains unknown-outcome handling even for an exception named like a local preflight refusal", async () => fixture(async ({ initial, store, requests }) => {
  let calls = 0;
  const stopped = await continueLinkResearchTask(initial.task.id, {}, { store, host: { callTool: async () => {
    calls++; throw Object.assign(new Error("The external host did not confirm whether work began."), { code: "SESSION_INCOMPATIBLE" });
  } } });
  assert.equal(stopped.task.status, "needs_attention"); assert.equal(stopped.task.stop_reason, "outcome_unknown");
  assert.equal(stopped.task.actions.at(-1)?.state, "unknown"); assert.equal(calls, 1);
  assert.equal(stopped.task.budget.reserved_timeout_seconds, initial.task.budget.reserved_timeout_seconds + 60);
  const again = await continueLinkResearchTask(initial.task.id, {}, { store, host: { callTool: async () => { calls++; return {}; } } });
  assert.deepEqual(again, stopped); assert.equal(calls, 1); assert.equal(requests(), 0);
}));
