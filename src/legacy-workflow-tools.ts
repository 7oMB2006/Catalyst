import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { followUpLongVideoResearch } from "./research-sessions.js";
import { longVideoResultShape } from "./long-video-schema.js";
import { compareResearchMaterials } from "./comparison.js";
import { comparisonInputSchema, comparisonResultShape } from "./comparison-schema.js";
import type { ComparisonInput } from "./comparison-contracts.js";
import { planResearchFollowup } from "./followup-plan.js";
import { followupPlanRequestSchema, followupPlanResultShape } from "./followup-plan-schema.js";
import { registerLinkResearchTools } from "./link-research-tools.js";

/** Compatibility only: the default server leaves task planning and answers to its host. */
export function registerLegacyWorkflowTools(server: McpServer): void {
  registerLinkResearchTools(server);
  const planInput = followupPlanRequestSchema.shape;
  server.registerTool("plan_research_followup", {
    title: "Plan Bounded Follow-up Research",
    description: "Check one to three already-read research results or saved long-video sessions for missing evidence coverage and return bounded, typed calls to existing tools. The host selects and executes suggestions, retaining new evidence and supplying round/history on the next plan. Defaults preserve each material's original requested scope and evidence mode. Changing a question invalidates old visual coverage, while source text remains reusable. Explicit search_queries may request Bilibili discovery; single-source or not-addressed claims do not themselves trigger more research. A deterministic read-only plan: no models, platform requests, media acquisition, action execution or persistence. A stopped plan does not establish semantic sufficiency.",
    inputSchema: z.strictObject({
      question: planInput.question.describe("Current research question. Original source text is reusable; question-specific visual observations are not."),
      materials: planInput.materials.describe("One to three full video/note/xiaohongshu research results or saved session references. Discovery candidates and final answers alone are not read evidence."),
      evidence_requirement: planInput.evidenceRequirement.describe("original inherits each material's mode; explicitly select language, vision or multimodal when the question requires different channels."),
      coverage_target: planInput.coverageTarget.describe("requested preserves prior selected time/page scopes; source explicitly extends to the known complete video or note."),
      search_queries: planInput.searchQueries.describe("Optional explicit host queries for extra Bilibili discovery. Omit to avoid planning search."),
      discovery: planInput.discovery.describe("Optional previous discovery result, used only to preserve search access restrictions."),
      max_actions: planInput.maxActions.describe("Maximum actions returned in this plan."),
      max_sources: planInput.maxSources.describe("Maximum known sources used by this plan's reading actions; uninspected search candidates are not read sources."),
      max_rounds: planInput.maxRounds.describe("Host-managed total round limit; planning never increments it automatically."),
      round: planInput.round.describe("Current host-managed round, starting at one."),
      attempted_action_keys: planInput.attemptedActionKeys.describe("Keys of actions already attempted by the host; identical actions are not automatically retried."),
      video_window_seconds: planInput.videoWindowSeconds.describe("Maximum seconds in each proposed video window; saved-session resumes must also fit their original planned window sizes."),
      note_pages_per_action: planInput.notePagesPerAction.describe("Maximum original image pages per proposed note action."),
      action_timeout_seconds: planInput.actionTimeoutSeconds.describe("Execution timeout placed in suggested tool arguments; no execution is performed by planning."),
      planning_timeout_seconds: planInput.planningTimeoutSeconds.describe("Shared deadline for this read-only material preparation and plan."),
    }),
    outputSchema: followupPlanResultShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ question, materials, evidence_requirement, coverage_target, search_queries, discovery, max_actions, max_sources, max_rounds, round, attempted_action_keys, video_window_seconds, note_pages_per_action, action_timeout_seconds, planning_timeout_seconds }, extra) => {
    const plan = await planResearchFollowup({
      question, materials: materials as unknown as ComparisonInput[], evidenceRequirement: evidence_requirement,
      coverageTarget: coverage_target, searchQueries: search_queries, discovery, maxActions: max_actions,
      maxSources: max_sources, maxRounds: max_rounds, round, attemptedActionKeys: attempted_action_keys,
      videoWindowSeconds: video_window_seconds, notePagesPerAction: note_pages_per_action,
      actionTimeoutSeconds: action_timeout_seconds, planningTimeoutSeconds: planning_timeout_seconds,
    }, {}, extra.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }], structuredContent: { ...plan }, isError: plan.status === "unavailable" };
  });

  server.registerTool("compare_research_materials", {
    title: "Compare Selected Research Evidence",
    description: "Compare two or three explicitly selected, already-read research results or local long-video sessions. Pass video/note results or the full Xiaohongshu wrapper as result; each material is validated separately. One text-model call compares claims with exact quoted excerpts, retaining video source windows or image page numbers. Original final answers are excluded; earlier visual Findings are eligible only for the same question and remain derived observations. Missing evidence is distinct from contradiction. Source identities do not establish independent corroboration. No platform fetches, media, ASR, automatic research, or comparison persistence.",
    inputSchema: z.strictObject({
      question: z.string().trim().min(3).max(2000),
      materials: z.array(comparisonInputSchema).min(2).max(3).describe("Two or three selected full structured research results (video/note/xiaohongshu) or session references. Discovery candidates are not read evidence."),
      language: z.string().min(2).max(20).optional(),
      max_comparisons: z.number().int().min(1).max(8).default(6),
      timeout_seconds: z.number().min(1).max(300).default(120),
    }),
    outputSchema: comparisonResultShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ question, materials, language, max_comparisons, timeout_seconds }, extra) => {
    const comparison = await compareResearchMaterials({ question, materials: materials as unknown as ComparisonInput[], language, maxComparisons: max_comparisons, timeoutSeconds: timeout_seconds }, {}, extra.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(comparison, null, 2) }], structuredContent: { ...comparison }, isError: comparison.status === "unavailable" };
  });

  function sessionFailure(error: unknown) {
    const value = error as { code?: string; message?: string };
    const issue = { code: value.code ?? "SESSION_FAILED", message: value.message ?? "The session operation failed." };
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: issue }) }], isError: true };
  }
  const sessionIdSchema = z.string().uuid().describe("Local research session UUID returned by analyze_long_video_url or list_research_sessions.");
  server.registerTool("follow_up_long_video_research", {
    title: "Ask a New Question About a Saved Video",
    description: "Create an independent saved question from a compatible long-video session. Reuses saved source captions or ASR, never the parent's reports, relevance or final answer. Recomputes relevance and focus for the new question. Language mode uses saved text only; multimodal locates detail windows from text and acquires only those clips for new visual analysis. Missing material remains explicit. The selected video, part, time range and language stay fixed; the parent record is unchanged. No cross-video search or background work.",
    inputSchema: z.strictObject({
      session_id: sessionIdSchema,
      question: z.string().trim().min(3).describe("A new research question about the same selected video and saved source interval."),
      mode: z.enum(["language", "multimodal"]).default("language").describe("language answers from saved captions/ASR only; multimodal additionally inspects newly selected detail clips. Transcripts do not establish visual evidence."),
      url: z.string().min(1).max(8192).optional().describe("Optional fresh source/share URL; it must resolve to the same video and selected part. Access parameters are not saved."),
      max_detail_windows: z.number().int().min(0).max(4).optional().describe("Language requires 0 (default). Multimodal requires 1 to 4 (default 2)."),
      detail_window_seconds: z.number().int().min(30).max(300).optional(),
      timeout_seconds: z.number().min(5).max(1800).optional(),
      window_timeout_seconds: z.number().int().min(15).max(600).optional(),
      max_download_mb: z.number().int().min(32).max(2048).optional(),
    }),
    outputSchema: longVideoResultShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ session_id, question, mode, url, max_detail_windows, detail_window_seconds, timeout_seconds, window_timeout_seconds, max_download_mb }, extra) => {
    try {
      const research = await followUpLongVideoResearch(session_id, { question, mode, url, maxDetailWindows: max_detail_windows, detailWindowSeconds: detail_window_seconds,
        timeoutSeconds: timeout_seconds, windowTimeoutSeconds: window_timeout_seconds, maxDownloadMB: max_download_mb }, { signal: extra.signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(research, null, 2) }], structuredContent: { ...research }, isError: research.status === "unavailable" };
    } catch (error) { return sessionFailure(error); }
  });
}
