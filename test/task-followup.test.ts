import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonInput, ComparisonResult } from "../src/comparison-contracts.js";
import type { Evidence } from "../src/contracts.js";
import type { LinkResearchTaskRecord, LinkResearchTaskStorage } from "../src/link-research-contracts.js";
import type { LongVideoResult } from "../src/long-video-contracts.js";
import type { NoteEvidence, NoteResearchResult } from "../src/note-contracts.js";
import type { ResearchTaskHost } from "../src/research-task-contracts.js";
import { answerResearchMaterials } from "../src/comparison.js";
import { startLinkResearchTask, followUpLinkResearchTask, continueLinkResearchTask, getLinkResearchTask } from "../src/link-research.js";
import { LinkResearchTaskStore } from "../src/link-research-store.js";
import { linkActionKey } from "../src/link-research-schema.js";
import { researchXiaohongshuNote } from "../src/note-research.js";
import { startLongVideoResearch } from "../src/research-sessions.js";
import { engineHost, NOTE_URL, QUESTION, VIDEO_ONE, wire } from "./helpers/link-research-fixtures.js";

const FOLLOW_UP = "Using these materials, list the smallest implementation steps and their source evidence.";
const NEXT_QUESTION = "Which steps do the retained materials explicitly assign to tools?";
const OLD_REPORT = "OLD_PARENT_REPORT_MUST_NOT_BECOME_FOLLOWUP_EVIDENCE";
const OLD_FINDING = "OLD_PARENT_FINDING_MUST_NOT_BECOME_FOLLOWUP_EVIDENCE";
const OLD_SEGMENT = "OLD_PARENT_SEGMENT_REPORT_MUST_NOT_BECOME_FOLLOWUP_EVIDENCE";

function catalogResponse(prompt: string): string {
  const marker = "QUOTE CATALOG:\n\n", offset = prompt.lastIndexOf(marker);
  assert.notEqual(offset, -1, "the actual answer engine must use code-selected excerpt IDs");
  const catalog = JSON.parse(prompt.slice(offset + marker.length)) as Array<{ id: string; material_id: string }>;
  const ids = [...new Set(catalog.map(item => item.material_id))];
  assert.ok(ids.length);
  return JSON.stringify({ comparisons: [{
    claim: "Implement delegated execution through a bounded tool operation.",
    positions: ids.map(id => ({ material_id: id, stance: "supports", citation_ids: [catalog.find(item => item.material_id === id)!.id], explanation: "The retained original source describes a delegated tool operation." })),
    limitations: ["The supplied excerpts do not establish unmentioned implementation details."],
  }] });
}

async function fixture(work: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "catalyst task followup "));
  try { await work(await setup(directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function setup(directory: string) {
  const tasks = new LinkResearchTaskStore(join(directory, "task snapshots")), sessions = join(directory, "video sessions");
  const engine = engineHost(sessions), prompts: string[] = [], answers: Array<Record<string, unknown>> = [];
  const settings = { loseAcknowledgement: false, poisonReports: false };
  const host: ResearchTaskHost = { callTool: async (name, args, signal) => {
    if (name !== "answer_research_materials") {
      const value = wire(await engine.host.callTool(name, args, signal)) as Record<string, unknown>;
      if (settings.poisonReports && name !== "compare_research_materials") {
        const leaf = ("content_type" in value ? value.result : value) as { analysis: string | null; findings: Array<{ statement: string }>; segments?: Array<{ analysis: string | null }> } | null;
        if (leaf) {
          leaf.analysis = OLD_REPORT;
          for (const finding of leaf.findings) finding.statement = OLD_FINDING;
          for (const segment of leaf.segments ?? []) if (segment.analysis) segment.analysis = OLD_SEGMENT;
        }
      }
      return value;
    }
    answers.push(structuredClone(args));
    if (settings.loseAcknowledgement) throw new Error("Fixture answer transport lost acknowledgement after dispatch.");
    return wire(await answerResearchMaterials({ question: args.question as string, materials: args.materials as ComparisonInput[], language: args.language as string | undefined, timeoutSeconds: args.timeout_seconds as number }, { analyzeText: async prompt => { prompts.push(prompt); return catalogResponse(prompt); } }, signal));
  } };
  const start = (urls = [VIDEO_ONE], mode: "language" | "vision" | "multimodal" = "language") => startLinkResearchTask({ urls, question: QUESTION, mode, segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0, actionTimeoutSeconds: 30, totalTimeoutSeconds: 900 }, { store: tasks, host });
  const bytes = (id: string) => fs.readFile(join(tasks.directory, `${id}.json`), "utf8");
  return { directory, tasks, sessions, engine, prompts, answers, settings, host, start, bytes };
}
function allLeafEvidence(materials: ComparisonInput[]) {
  return materials.flatMap<Evidence | NoteEvidence>(material => {
    if (material.kind === "session") throw new Error("Follow-up snapshots must not retain session references.");
    const leaf = material.kind === "xiaohongshu" ? material.result.result : material.result;
    return leaf?.evidence ?? [];
  });
}
function assertCitations(answer: ComparisonResult): void {
  const evidence = new Map(answer.evidence.map(item => [item.id, item]));
  for (const row of answer.comparisons) for (const position of row.positions) for (const citation of position.citations) {
    const item = evidence.get(citation.evidence_id);
    assert.ok(item); assert.equal(item.material_id, position.material_id); assert.ok(item.content.includes(citation.quote));
    assert.ok(item.locator.time_range || item.locator.page !== null || item.kind === "note_text");
  }
}
test("one-link task follow-up creates a saved cited answer without rereading source content or changing its parent", async () => fixture(async ({ tasks, engine, host, start, bytes, prompts, answers }) => {
  const parent = await start(), original = await bytes(parent.task.id), effects = wire(engine.calls), acquired = wire(engine.windows);
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP }, { store: tasks, host });
  assert.notEqual(child.task.id, parent.task.id); assert.equal(child.task.request.question, FOLLOW_UP);
  assert.equal(child.task.follow_up?.parent_task_id, parent.task.id); assert.equal(child.task.follow_up?.parent_revision, parent.task.revision);
  assert.deepEqual(child.task.sources, parent.task.sources); assert.equal(await bytes(parent.task.id), original);
  assert.deepEqual(engine.calls, effects); assert.deepEqual(engine.windows, acquired); assert.equal(answers.length, 1); assert.equal(prompts.length, 1);
  assert.deepEqual(child.task.actions.map(a => a.tool), ["answer_research_materials"]);
  assert.equal(child.task.actions[0].source_id, null); assert.deepEqual(child.task.actions[0].basis, []);
  assert.match(String(child.task.actions[0].arguments.materials_hash), /^[a-f0-9]{64}$/);
  assert.equal(child.answer_current, true); assert.equal(child.answer?.question, FOLLOW_UP); assert.ok(child.answer?.analysis); assert.equal(child.answer?.materials.length, 1);
  assertCitations(child.answer!);
  assert.deepEqual((await tasks.load(parent.task.id)).budget, parent.task.budget);
  const repeated = await continueLinkResearchTask(child.task.id, {}, { store: new LinkResearchTaskStore(tasks.directory), host });
  assert.deepEqual(repeated, child); assert.equal(answers.length, 1); assert.deepEqual(engine.calls, effects);
}));

test("mixed-source follow-up uses original video and note text while excluding every old generated report", async () => fixture(async ({ tasks, engine, host, start, bytes, prompts, settings }) => {
  settings.poisonReports = true;
  const parent = await start([VIDEO_ONE, NOTE_URL]);
  settings.poisonReports = false;
  const original = await bytes(parent.task.id), effects = wire(engine.calls);
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP }, { store: tasks, host });
  assert.equal(await bytes(parent.task.id), original); assert.deepEqual(engine.calls, effects); assert.equal(child.answer_current, true);
  assert.deepEqual(child.task.follow_up?.snapshots.map(s => s.source_id), ["source:1", "source:2"]);
  const serialized = JSON.stringify(child.task.follow_up);
  for (const poison of [OLD_REPORT, OLD_FINDING, OLD_SEGMENT]) { assert.ok(!serialized.includes(poison)); assert.ok(prompts.every(prompt => !prompt.includes(poison))); }
  const evidence = allLeafEvidence(child.materials);
  assert.ok(evidence.some(e => e.kind === "asr")); assert.ok(evidence.some(e => e.kind === "image_text"));
  assert.ok(evidence.every(e => ["caption", "asr", "note_text", "image_text"].includes(e.kind)));
  assert.ok(child.answer?.evidence.some(e => e.locator.platform === "bilibili" && e.locator.time_range));
  assert.ok(child.answer?.evidence.some(e => e.locator.platform === "xiaohongshu" && e.locator.page !== null));
  assertCitations(child.answer!);
}));

test("a child snapshot and a later question remain usable after the original task and video sessions are deleted", async () => fixture(async ({ tasks, sessions, engine, host, start, answers }) => {
  const parent = await start([VIDEO_ONE, NOTE_URL]);
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP }, { store: tasks, host });
  await tasks.delete(parent.task.id); await fs.rm(sessions, { recursive: true, force: true });
  const effects = wire(engine.calls), count = answers.length, freshStore = new LinkResearchTaskStore(tasks.directory);
  assert.deepEqual(await getLinkResearchTask(child.task.id, { store: freshStore }), child);
  assert.deepEqual(await continueLinkResearchTask(child.task.id, {}, { store: freshStore, host }), child);
  const descendant = await followUpLinkResearchTask(child.task.id, { question: NEXT_QUESTION }, { store: freshStore, host });
  assert.equal(descendant.task.follow_up?.parent_task_id, child.task.id); assert.equal(descendant.answer_current, true);
  assert.equal(descendant.answer?.question, NEXT_QUESTION); assert.equal(answers.length, count + 1); assert.deepEqual(engine.calls, effects);
  assertCitations(descendant.answer!);
}));

test("a language question after a visual child still reuses the original raw text provenance", async () => fixture(async ({ tasks, engine, host, start }) => {
  const parent = await start();
  const visual = await followUpLinkResearchTask(parent.task.id, { question: "What does the inspected workflow diagram show?", mode: "vision", segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0 }, { store: tasks, host });
  assert.equal(visual.answer_current, true);
  assert.ok(visual.answer!.evidence.every(evidence => evidence.basis === "derived_observation"));
  const effects = wire(engine.calls);
  const language = await followUpLinkResearchTask(visual.task.id, { question: NEXT_QUESTION }, { store: tasks, host });
  assert.equal(language.answer_current, true); assert.ok(language.answer?.evidence.some(evidence => evidence.kind === "asr"));
  assert.ok(language.answer!.evidence.every(evidence => ["caption", "asr"].includes(evidence.kind)));
  assert.deepEqual(engine.calls, effects); assertCitations(language.answer!);
}));

test("partial source text remains partial and a language follow-up never acquires the parent's missing interval", async () => fixture(async ({ tasks, engine, host, start, answers }) => {
  engine.settings.duration = 240; engine.settings.failWindow = (_url, start) => start === 120;
  const parent = await start(), effects = wire(engine.calls), windows = wire(engine.windows);
  assert.equal(parent.task.status, "partial");
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP }, { store: tasks, host });
  assert.deepEqual(engine.calls, effects); assert.deepEqual(engine.windows, windows); assert.equal(answers.length, 1);
  assert.equal(child.materials[0].kind, "video");
  if (child.materials[0].kind !== "video") throw new Error("Expected retained video text.");
  assert.equal(child.materials[0].result.status, "partial"); assert.equal(child.answer?.status, "partial");
  assert.ok(child.answer?.evidence.length); assert.ok(child.answer!.evidence.every(e => !e.locator.time_range || e.locator.time_range.end_seconds <= 120));
  const repeated = await continueLinkResearchTask(child.task.id, {}, { store: tasks, host });
  assert.deepEqual(repeated, child); assert.equal(answers.length, 1); assert.deepEqual(engine.windows, windows);
}));

test("a visual-only parent cannot supply old visual claims as text evidence for a new language question", async () => fixture(async ({ tasks, engine, host, start, prompts }) => {
  const parent = await start([VIDEO_ONE], "vision"), effects = wire(engine.calls), windows = wire(engine.windows);
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP }, { store: tasks, host });
  assert.deepEqual(engine.calls, effects); assert.deepEqual(engine.windows, windows); assert.equal(prompts.length, 0);
  assert.ok(!child.answer || child.answer.status === "unavailable"); assert.notEqual(child.task.status, "completed");
  assert.equal(allLeafEvidence(child.materials).filter(e => ["visual", "multimodal", "image_visual"].includes(e.kind)).length, 0);
}));

test("a new multimodal question makes fresh visual reads while reusing the parent's raw text", async () => fixture(async ({ tasks, engine, host, start, prompts, settings }) => {
  settings.poisonReports = true;
  const parent = await start([VIDEO_ONE, NOTE_URL], "multimodal");
  settings.poisonReports = false;
  const count = engine.calls.length, windows = engine.windows.length, notePasses = engine.notePages.length;
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, mode: "multimodal", segmentSeconds: 120, maxSegments: 4, maxDetailWindows: 0 }, { store: tasks, host });
  const fresh = engine.calls.slice(count);
  assert.equal(fresh.length, 2); assert.ok(fresh.every(call => call.args.mode === "vision"));
  assert.ok(engine.windows.length > windows); assert.ok(engine.notePages.length > notePasses);
  assert.equal(child.task.status, "completed"); assert.ok(child.progress.every(progress => progress.status === "complete" && !progress.can_continue));
  assert.equal(child.answer_current, true); assert.equal(child.answer?.question, FOLLOW_UP);
  const evidence = allLeafEvidence(child.materials);
  assert.ok(evidence.some(e => e.kind === "asr")); assert.ok(evidence.some(e => e.kind === "image_text"));
  assert.ok(evidence.some(e => e.kind === "visual")); assert.ok(evidence.some(e => e.kind === "image_visual"));
  for (const poison of [OLD_REPORT, OLD_FINDING, OLD_SEGMENT]) assert.ok(prompts.every(prompt => !prompt.includes(poison)));
  for (const action of child.task.actions.filter(a => a.source_id)) {
    const raw = action.result!, leaf = ("content_type" in raw ? raw.result : raw) as LongVideoResult | NoteResearchResult;
    assert.ok(leaf.evidence.every(e => e.kind !== "asr"), "fresh visual research must not repeat transcription");
  }
  assertCitations(child.answer!);
  const effects = wire(engine.calls);
  assert.deepEqual(await continueLinkResearchTask(child.task.id, {}, { store: tasks, host }), child);
  assert.deepEqual(engine.calls, effects);
}));

test("a known visual note resolution failure preserves seed text and a partial answer without an unknown action", async () => fixture(async ({ tasks, engine, host, start }) => {
  const parent = await start([NOTE_URL]), effects = wire(engine.calls), acquired = wire(engine.notePages);
  let failures = 0;
  const restricted: ResearchTaskHost = { callTool: async (name, args, signal) => {
    if (name !== "analyze_xiaohongshu_note") return host.callTool(name, args, signal);
    failures++;
    return researchXiaohongshuNote({ url: args.url as string, question: args.question as string, mode: "vision", timeoutSeconds: args.timeout_seconds as number }, {
      resolve: async () => { throw Object.assign(new Error("Fixture note access expired before acquisition."), { code: "AUTH_REQUIRED" }); },
    }, signal);
  } };
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, mode: "multimodal", maxDetailWindows: 0 }, { store: tasks, host: restricted });
  assert.equal(failures, 1); assert.deepEqual(engine.calls, effects); assert.deepEqual(engine.notePages, acquired);
  assert.equal(child.task.actions[0].state, "recorded"); assert.equal(child.task.actions[0].result?.status, "unavailable");
  assert.ok(child.task.actions.every(action => action.state !== "unknown")); assert.notEqual(child.task.status, "completed");
  assert.equal(child.answer_current, true); assert.equal(child.answer?.status, "partial");
  assert.ok(allLeafEvidence(child.materials).some(evidence => evidence.kind === "image_text"));
  assert.ok(child.answer?.evidence.some(evidence => evidence.locator.page !== null)); assertCitations(child.answer!);
  assert.deepEqual(await getLinkResearchTask(child.task.id, { store: new LinkResearchTaskStore(tasks.directory) }), child);
  const recovered = await continueLinkResearchTask(child.task.id, { sourceUrls: [{ sourceId: "source:1", url: `${NOTE_URL}?xsec_token=fixture-fresh-access` }] }, { store: tasks, host });
  assert.equal(recovered.task.status, "completed"); assert.equal(recovered.answer_current, true); assert.equal(recovered.answer?.status, "complete");
  assert.deepEqual(recovered.task.actions.map(action => action.tool), ["analyze_xiaohongshu_note", "answer_research_materials", "analyze_xiaohongshu_note", "answer_research_materials"]);
  assert.equal(recovered.task.actions[0].result?.status, "unavailable", "the known failed attempt remains inspectable");
  assert.ok(recovered.task.actions.every(action => action.state === "recorded")); assert.ok(!JSON.stringify(recovered.task).includes("fixture-fresh-access"));
  assertCitations(recovered.answer!);
}));

test("a child's independent allowance persists across retries and does not reset or charge its parent", async () => fixture(async ({ tasks, engine, host, start, bytes, answers }) => {
  const parent = await start(), original = await bytes(parent.task.id), effects = wire(engine.calls);
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, totalTimeoutSeconds: 15, actionTimeoutSeconds: 60, maxActions: 1 }, { store: tasks, host });
  assert.equal(child.task.status, "budget_exhausted"); assert.equal(child.task.actions.length, 0); assert.equal(answers.length, 0);
  assert.deepEqual(child.task.budget, { max_actions: 1, attempted_actions: 0, total_timeout_seconds: 15, reserved_timeout_seconds: 0 });
  const again = await continueLinkResearchTask(child.task.id, {}, { store: new LinkResearchTaskStore(tasks.directory), host });
  assert.deepEqual(again, child); assert.deepEqual(engine.calls, effects); assert.equal(await bytes(parent.task.id), original);
}));

test("a missing follow-up answer acknowledgement stays unknown after reload and is not replayed", async () => fixture(async ({ tasks, engine, host, start, settings, answers, bytes }) => {
  const parent = await start(), original = await bytes(parent.task.id), effects = wire(engine.calls);
  settings.loseAcknowledgement = true;
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, actionTimeoutSeconds: 15, totalTimeoutSeconds: 30 }, { store: tasks, host });
  assert.equal(child.task.status, "needs_attention"); assert.equal(child.task.actions[0].state, "unknown"); assert.equal(answers.length, 1);
  assert.equal(child.task.budget.reserved_timeout_seconds, 15); assert.equal(await bytes(parent.task.id), original);
  settings.loseAcknowledgement = false;
  const again = await continueLinkResearchTask(child.task.id, {}, { store: new LinkResearchTaskStore(tasks.directory), host });
  assert.deepEqual(again, child); assert.equal(answers.length, 1); assert.deepEqual(engine.calls, effects);
}));

test("a returned answer that could not be committed leaves intent for safe recovery without another model call", async () => fixture(async ({ tasks, host, start, answers }) => {
  const parent = await start();
  const failing: LinkResearchTaskStorage = {
    newId: () => tasks.newId(), load: id => tasks.load(id), withLock: (id, operation) => tasks.withLock(id, operation),
    save: async (record, revision) => {
      if (record.follow_up && record.actions.some(a => a.tool === "answer_research_materials" && a.state === "recorded")) throw Object.assign(new Error("Fixture durable answer write failed"), { code: "TASK_IO_ERROR" });
      return tasks.save(record, revision);
    },
  };
  await assert.rejects(followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, actionTimeoutSeconds: 15 }, { store: failing, host }));
  const saved = (await tasks.list()).find(record => record.follow_up?.parent_task_id === parent.task.id);
  assert.ok(saved); assert.equal(saved.actions[0].state, "running"); assert.equal(answers.length, 1);
  const recovered = await continueLinkResearchTask(saved.id, {}, { store: new LinkResearchTaskStore(tasks.directory), host });
  assert.equal(recovered.task.actions[0].state, "unknown"); assert.equal(recovered.task.status, "needs_attention"); assert.equal(answers.length, 1);
  assert.deepEqual(recovered.task.budget, saved.budget);
}));

for (const corruption of ["raw snapshot text", "answer input hash"] as const) {
  test(`tampering with ${corruption} is rejected before any follow-up work`, async () => fixture(async ({ tasks, host, start, answers, engine }) => {
    const parent = await start(), child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP }, { store: tasks, host });
    const path = join(tasks.directory, `${child.task.id}.json`), record = JSON.parse(await fs.readFile(path, "utf8")) as LinkResearchTaskRecord;
    if (corruption === "raw snapshot text") {
      const material = record.follow_up!.snapshots.find(snapshot => snapshot.material)?.material;
      assert.ok(material);
      const item = material.result.evidence.find(item => item.content?.trim()); assert.ok(item); item.content += " An uncommitted foreign sentence.";
    } else {
      const action = record.actions.find(a => a.tool === "answer_research_materials"); assert.ok(action);
      action.arguments.materials_hash = "0".repeat(64); action.key = linkActionKey(action);
    }
    await fs.writeFile(path, JSON.stringify(record));
    const count = answers.length, effects = wire(engine.calls);
    await assert.rejects(getLinkResearchTask(child.task.id, { store: tasks }));
    await assert.rejects(continueLinkResearchTask(child.task.id, {}, { store: tasks, host }));
    assert.equal(answers.length, count); assert.deepEqual(engine.calls, effects);
  }));
}

test("a fresh source URL recovers a known initial video visual-resolution failure without retranscribing parent text", async () => fixture(async ({ tasks, engine, host, start, bytes, answers }) => {
  const parent = await start(), original = await bytes(parent.task.id), windows = engine.windows.length;
  let accessUnavailable = true, visualReads = 0;
  const recovering: ResearchTaskHost = { callTool: async (name, args, signal) => {
    if (name === "analyze_long_video_url" && args.question === FOLLOW_UP) {
      visualReads++; assert.equal(args.mode, "vision");
      if (accessUnavailable) return startLongVideoResearch({
        url: args.url as string, question: args.question as string, mode: "vision", language: args.language as string | undefined,
        segmentSeconds: args.segment_seconds as number, maxSegments: args.max_segments as number,
        maxDetailWindows: args.max_detail_windows as number, detailWindowSeconds: args.detail_window_seconds as number,
        timeoutSeconds: args.timeout_seconds as number, windowTimeoutSeconds: args.window_timeout_seconds as number, maxDownloadMB: args.max_download_mb as number,
      }, { store: engine.sessions, signal, dependencies: {
        resolve: async () => { throw Object.assign(new Error("Fixture video access expired before source resolution."), { code: "AUTH_REQUIRED" }); },
      } });
    }
    return host.callTool(name, args, signal);
  } };
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, mode: "multimodal", maxDetailWindows: 0 }, { store: tasks, host: recovering });
  const failed = wire(child.task.actions[0]);
  assert.equal(failed.state, "recorded"); assert.equal(failed.result?.status, "unavailable");
  assert.equal(failed.result?.video, null); assert.equal(failed.result?.session, null);
  assert.equal(child.answer_current, true); assert.equal(child.answer?.status, "partial");
  assert.equal(visualReads, 1); assert.equal(engine.windows.length, windows); assert.equal(answers.length, 1);
  accessUnavailable = false;
  const recovered = await continueLinkResearchTask(child.task.id, { sourceUrls: [{ sourceId: "source:1", url: `${VIDEO_ONE}?access_refresh=transient-video-access` }] }, { store: tasks, host: recovering });
  assert.equal(visualReads, 2); assert.equal(recovered.task.status, "completed"); assert.equal(recovered.answer_current, true); assert.equal(recovered.answer?.status, "complete");
  assert.deepEqual(recovered.task.actions.map(action => action.tool), ["analyze_long_video_url", "answer_research_materials", "analyze_long_video_url", "answer_research_materials"]);
  assert.deepEqual(recovered.task.actions[0], failed); assert.ok(recovered.task.actions.every(action => action.state === "recorded"));
  const inspected = recovered.task.actions[2].result as unknown as LongVideoResult;
  assert.equal(inspected.request.mode, "vision"); assert.ok(inspected.evidence.some(evidence => evidence.kind === "visual"));
  assert.ok(inspected.evidence.every(evidence => evidence.kind !== "asr" && evidence.kind !== "caption"), "the new visual pass must not retranscribe or reread parent language material");
  assert.equal(engine.windows.length, windows + 1); assert.equal(answers.length, 2);
  assert.ok(allLeafEvidence(recovered.materials).some(evidence => evidence.kind === "asr" && evidence.id.startsWith("reused:")));
  assert.equal(await bytes(parent.task.id), original); assert.ok(!JSON.stringify(recovered.task).includes("transient-video-access"));
  assertCitations(recovered.answer!);
  const effects = wire(engine.calls);
  assert.deepEqual(await continueLinkResearchTask(child.task.id, {}, { store: tasks, host: recovering }), recovered);
  assert.deepEqual(engine.calls, effects); assert.equal(visualReads, 2); assert.equal(answers.length, 2);
}));

test("an equivalent partial visual receipt refreshes the answer's source history instead of leaving it permanently stale", async () => fixture(async ({ tasks, engine, host, start, answers }) => {
  engine.settings.duration = 240;
  const parent = await start();
  engine.settings.failWindow = (_url, start) => start === 120;
  const child = await followUpLinkResearchTask(parent.task.id, { question: FOLLOW_UP, mode: "multimodal", maxDetailWindows: 0 }, { store: tasks, host });
  assert.equal(child.answer_current, true); assert.equal(child.answer?.status, "partial");
  const native = wire(child.task.actions[0].result);
  const firstAnswer = child.task.actions.find(a => a.tool === "answer_research_materials")!;
  let resumes = 0;
  const equivalent: ResearchTaskHost = { callTool: async (name, args, signal) => {
    if (name === "resume_long_video_research") { resumes++; return wire(native); }
    return host.callTool(name, args, signal);
  } };
  const continued = await continueLinkResearchTask(child.task.id, {}, { store: tasks, host: equivalent });
  const last = continued.task.actions.at(-1)!;
  assert.equal(resumes, 1); assert.equal(answers.length, 2);
  assert.equal(last.tool, "answer_research_materials");
  assert.equal(last.arguments.materials_hash, firstAnswer.arguments.materials_hash, "the retained input is identical");
  assert.deepEqual(last.basis, [2]); assert.equal(continued.answer_current, true);
  assert.deepEqual(await getLinkResearchTask(child.task.id, { store: tasks }), continued);
}));
