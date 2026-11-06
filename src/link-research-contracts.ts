import type { ComparisonInput, ComparisonResult } from "./comparison-contracts.js";
import type { ResearchTaskHost } from "./research-task-contracts.js";

export interface LinkResearchRequest {
  urls: string[];
  question: string;
  mode?: "language" | "vision" | "multimodal";
  language?: string;
  totalTimeoutSeconds?: number;
  actionTimeoutSeconds?: number;
  maxActions?: number;
  segmentSeconds?: number;
  maxSegments?: number;
  maxDetailWindows?: number;
}
export interface NormalizedLinkResearchRequest extends LinkResearchRequest {
  mode: "language" | "vision" | "multimodal";
  totalTimeoutSeconds: number;
  actionTimeoutSeconds: number;
  maxActions: number;
  segmentSeconds: number;
  maxSegments: number;
  maxDetailWindows: number;
}
export interface LinkResearchSource { id: string; url: string; kind: "video" | "xiaohongshu" }
export type LinkResearchTool = "analyze_long_video_url" | "analyze_xiaohongshu_note" | "resume_long_video_research" | "compare_research_materials" | "answer_research_materials";
export interface FollowUpSourceSnapshot {
  source_id: string;
  material: Extract<ComparisonInput, { kind: "video" | "note" }> | null;
}
export interface LinkResearchAction {
  index: number;
  key: string;
  source_id: string | null;
  tool: LinkResearchTool;
  arguments: Record<string, unknown>;
  /** Earlier receipt indexes used by this call; comparison freshness is explicit. */
  basis: number[];
  timeout_seconds: number;
  state: "running" | "recorded" | "unknown";
  started_at: string;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}
export interface LinkResearchTaskRecord {
  schema_version: "2";
  kind: "link_research";
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  request: NormalizedLinkResearchRequest;
  sources: LinkResearchSource[];
  actions: LinkResearchAction[];
  status: "ready" | "running" | "completed" | "partial" | "needs_attention" | "budget_exhausted" | "cancelled";
  budget: { max_actions: number; attempted_actions: number; total_timeout_seconds: number; reserved_timeout_seconds: number };
  stop_reason: string;
  /** Self-contained source text, never the parent's generated reports or visual observations. */
  follow_up?: { parent_task_id: string; parent_revision: number; snapshots: FollowUpSourceSnapshot[] };
}
export interface LinkResearchTaskStorage {
  newId(): string;
  load(id: string): Promise<LinkResearchTaskRecord>;
  save(record: LinkResearchTaskRecord, expectedRevision: number | null): Promise<void>;
  withLock<T>(id: string, operation: () => Promise<T>): Promise<T>;
}
export interface LinkResearchTaskOptions {
  /** Tests or an embedding host may provide its existing tool dispatcher. */
  host?: ResearchTaskHost;
  store?: LinkResearchTaskStorage;
  signal?: AbortSignal;
}
export interface ContinueLinkResearchRequest {
  maxSteps?: number;
  /** Fresh acquisition URLs are used in memory and must name the saved source. */
  sourceUrls?: Array<{ sourceId: string; url: string }>;
}
export type FollowUpLinkResearchRequest = Omit<LinkResearchRequest, "urls"> & Pick<ContinueLinkResearchRequest, "sourceUrls">;
export interface LinkResearchTaskView {
  task: LinkResearchTaskRecord;
  progress: Array<{ source_id: string; status: "pending" | "complete" | "partial" | "unavailable"; can_continue: boolean; reason: string }>;
  materials: ComparisonInput[];
  comparison: ComparisonResult | null;
  comparison_current: boolean;
  answer?: ComparisonResult | null;
  answer_current?: boolean;
  limitations: string[];
}
