import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchResult } from "../src/contracts.js";
import { DiscoveryError, type DiscoveryResult, type SearchPage } from "../src/discovery-contracts.js";
import { discoverBilibiliVideos } from "../src/discovery.js";
import type { FollowupPlanRequest } from "../src/followup-plan-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { planResearchFollowup } from "../src/followup-plan.js";
import { createResearchTask, runResearchTask } from "../src/research-tasks.js";
import { ResearchTaskStore } from "../src/research-task-store.js";

const QUESTION = "Which sources describe efficient attention?";
const VIDEO = "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17";
const YOUTUBE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

function material(url: string): ResearchResult {
  const platform = url === VIDEO ? "bilibili" : "youtube", id = platform === "bilibili" ? "BV1DTxXzUEvW" : "jNQXAC9IVRw";
  const part = platform === "bilibili" ? { partId: "38253823575" } : {};
  return {
    schema_version: "1.0", status: "complete",
    video: { platform, id, ...part, sourceUrl: url, canonicalUrl: url, title: "Read source", durationSeconds: 15 },
    request: { url, question: QUESTION, mode: "language", startSeconds: 0, endSeconds: 15 },
    capabilities: { metadata: { status: "available" }, captions: { status: "absent" }, media: { status: "available" }, comments: { status: "disabled" } },
    evidence: [{ id: "asr:1", kind: "asr", source: { platform, video_id: id, ...(part.partId ? { part_id: part.partId } : {}), url, origin: "fixture" }, time_range: { start_seconds: 0, end_seconds: 15 }, time_basis: "source", precision: "requested_window", content: "Retained original source text.", limitations: [] }],
    findings: [], analysis: "The requested source window was read.", warnings: [], errors: [],
    processing: { duration_ms: 0, stage_durations_ms: {}, provider: "fixture", usage: null },
  };
}

function searchPage(): SearchPage {
  return { hits: [{ video_id: "BV1xx411c7mD", part_number: null, canonical_url: "https://www.bilibili.com/video/BV1xx411c7mD/", title: "Candidate attention lesson", author: "Fixture author", duration_seconds: 120, snippet: "Untrusted search metadata", rank: 1 }], rows_received: 1, rows_discarded: 0, has_more: false, warnings: [] };
}

async function runDiscovery(queries: string[], options: { blockedQuery?: string; returnedQueries?: string[] } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst-task-query-normalization-"));
  const store = new ResearchTaskStore(directory), toolCalls: string[] = [], searched: string[] = [];
  let returned: DiscoveryResult | undefined;
  const request: FollowupPlanRequest = { question: QUESTION, materials: [{ kind: "video", result: material(VIDEO) }, { kind: "video", result: material(YOUTUBE) }], searchQueries: queries, actionTimeoutSeconds: 15 };
  const host: ResearchTaskHost = {
    callTool: async (name, args) => {
      toolCalls.push(name);
      if (name === "plan_research_followup") return planResearchFollowup(request);
      assert.equal(name, "discover_bilibili_videos", "only the selected discovery action may execute");
      returned = await discoverBilibiliVideos({ question: String(args.question), queries: options.returnedQueries ?? args.queries as string[], maxCandidates: Number(args.max_candidates), timeoutSeconds: Number(args.timeout_seconds) }, {
        search: async (query) => {
          searched.push(query);
          if (query === options.blockedQuery) throw new DiscoveryError("SEARCH_BLOCKED", "Fixture source search is blocked");
          return searchPage();
        },
      });
      return returned;
    },
  };
  try {
    const task = await createResearchTask({ plan: request }, { store, host });
    assert.equal(task.plan.next_actions.length, 1); assert.equal(task.plan.next_actions[0].tool, "discover_bilibili_videos");
    const finished = await runResearchTask(task.id, [task.plan.next_actions[0].key], { store, host });
    assert.ok(returned);
    const again = await runResearchTask(task.id, undefined, { store: new ResearchTaskStore(directory), host });
    assert.deepEqual(again, finished); assert.deepEqual(toolCalls, ["plan_research_followup", "discover_bilibili_videos"]);
    assert.deepEqual(await store.load(task.id), finished);
    return { finished, returned, searched };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("task records discovery candidates after duplicate, case and Unicode query normalization", async (t) => {
  const cases: Array<[string, string[], string[]]> = [
    ["identical duplicates", ["attention", "attention"], ["attention"]],
    ["case variants", ["attention", "Attention"], ["attention"]],
    ["Unicode and whitespace variants", ["  Ｓｅｌｆ\tAttention   ", "self  attention", "Sparse　attention"], ["Self Attention", "Sparse attention"]],
    ["distinct queries preserve their submitted order", ["sparse attention", "Linformer", "Linear attention"], ["sparse attention", "Linformer", "Linear attention"]],
  ];
  for (const [name, queries, expected] of cases) await t.test(name, async () => {
    const { finished, returned, searched } = await runDiscovery(queries);
    assert.deepEqual(searched, expected); assert.deepEqual(returned.queries.map(query => query.query), expected);
    assert.equal(finished.status, "completed"); assert.equal(finished.actions[0].state, "recorded");
    assert.deepEqual(finished.actions[0].result, returned);
    assert.equal(returned.candidates.length, 1); assert.equal(returned.candidates[0].content_status, "not_read");
    assert.equal(returned.candidates[0].media_access, "not_checked");
    assert.equal(finished.budget.attempted_actions, 1); assert.equal(finished.budget.reserved_timeout_seconds, 15);
  });
});

test("deduplicated partial discovery preserves candidates and access restrictions instead of unknown execution", async () => {
  const { finished, returned, searched } = await runDiscovery(["attention", "Attention", "Linformer"], { blockedQuery: "Linformer" });
  assert.deepEqual(searched, ["attention", "Linformer"]);
  assert.equal(returned.status, "partial"); assert.equal(returned.stop_reason, "blocked");
  assert.equal(finished.status, "partial"); assert.equal(finished.actions[0].state, "recorded");
  assert.deepEqual(finished.actions[0].result, returned); assert.equal(returned.candidates.length, 1);
  assert.ok(returned.errors.some(error => error.code === "SEARCH_BLOCKED"));
});

test("foreign discovery queries remain an unknown outcome and are not replayed", async () => {
  const { finished, returned } = await runDiscovery(["attention", "Attention"], { returnedQueries: ["unrequested topic"] });
  assert.equal(returned.status, "complete"); assert.equal(returned.candidates.length, 1);
  assert.equal(finished.status, "needs_attention"); assert.equal(finished.actions[0].state, "unknown");
  assert.equal(finished.actions[0].result, null); assert.equal(finished.actions[0].error?.code, "OUTCOME_UNKNOWN");
});
