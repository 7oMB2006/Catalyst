import type { ExecutionContext } from "./contracts.js";
import type { ComparisonInput } from "./comparison-contracts.js";
import type { DiscoveryResult } from "./discovery-contracts.js";
export interface PlanWindow { start_seconds: number; end_seconds: number }
export interface PlanPages { start_page: number; end_page: number }
export interface PlanningMaterial {
  id: string; source_key: string | null; url: string | null;
  family: "video" | "note" | null; original_mode: "language" | "vision" | "multimodal" | null;
  source_status: "complete" | "partial" | "unavailable"; eligible: boolean;
  requested_window: PlanWindow | null; duration_seconds: number | null;
  requested_pages: PlanPages | null; image_count: number | null;
  language_windows: PlanWindow[]; visual_windows: PlanWindow[]; language_pages: number[]; visual_pages: number[];
  evidence_ids: string[]; visual_question_changed: boolean; session_id: string | null; can_resume: boolean; resume_window_seconds?: number;
  language?: string; source_quality?: { profile?: "standard" | "high" | "custom"; resolution?: "720p" | "1080p" | "1440p" | "2160p"; fps?: 30 | 60; on_unavailable?: "error" | "warn" };
  access: "not_checked" | "blocked" | "auth_required" | "rate_limited";
  errors: Array<{ code: string; message: string }>; limitations: string[];
}
export interface FollowupPlanRequest {
  question: string; materials: ComparisonInput[];
  evidenceRequirement?: "original" | "language" | "vision" | "multimodal";
  coverageTarget?: "requested" | "source"; searchQueries?: string[]; discovery?: DiscoveryResult;
  maxActions?: number; maxSources?: number; maxRounds?: number; round?: number; attemptedActionKeys?: string[];
  videoWindowSeconds?: number; notePagesPerAction?: number; actionTimeoutSeconds?: number; planningTimeoutSeconds?: number;
}
export type FollowupTool = "analyze_video_url" | "analyze_xiaohongshu_note" | "resume_long_video_research" | "discover_bilibili_videos";
export interface FollowupGap {
  id: string; material_ids: string[]; source_key: string | null;
  kind: "coverage_gap" | "scope_extension" | "visual_question_changed" | "access_blocked" | "invalid_material" | "requested_search";
  channel: "language" | "vision" | "multimodal" | null;
  window: PlanWindow | null; pages: PlanPages | null;
  evidence_ids: string[]; reason: string;
  state: "actionable" | "blocked" | "deferred" | "previously_attempted" | "needs_selection";
}
export interface FollowupAction {
  key: string; gap_ids: string[]; material_ids: string[]; source_key: string | null;
  tool: FollowupTool; arguments: Record<string, unknown>; reason: string; preconditions: string[];
}
export interface FollowupPlanResult {
  schema_version: "1.0"; status: "planned" | "stopped" | "unavailable"; question: string;
  materials: PlanningMaterial[]; gaps: FollowupGap[]; next_actions: FollowupAction[];
  stop_reason: "actions_available" | "no_actionable_gaps" | "budget_exhausted" | "history_exhausted" | "blocked" | "cancelled" | "timeout" | "invalid_request";
  budget: { max_actions: number; max_sources: number; max_rounds: number; round: number; deferred_gaps: number };
  warnings: string[]; errors: Array<{ code: string; message: string }>;
  processing: { duration_ms: number; model_calls: 0; executed_actions: 0 };
}
export interface FollowupPlanDependencies { prepare(inputs: ComparisonInput[], question: string, context: ExecutionContext): Promise<PlanningMaterial[]> }
