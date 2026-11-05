import type { FollowupPlanRequest, FollowupPlanResult, FollowupAction } from "./followup-plan-contracts.js";

/** The host supplies its existing MCP connection. Returned values are structuredContent. */
export interface ResearchTaskHost {
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface ResearchTaskAction {
  key: string;
  state: "pending" | "running" | "recorded" | "unknown";
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}
export interface ResearchTaskRecord {
  schema_version: "1";
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  request: FollowupPlanRequest;
  plan: FollowupPlanResult;
  selected_keys: string[] | null;
  actions: ResearchTaskAction[];
  status: "planned" | "running" | "completed" | "partial" | "needs_attention" | "budget_exhausted" | "cancelled";
  budget: { max_actions: number; attempted_actions: number; total_timeout_seconds: number; reserved_timeout_seconds: number };
  stop_reason: string;
}
export interface ResearchTaskStorage {
  newId(): string;
  load(id: string): Promise<ResearchTaskRecord>;
  save(record: ResearchTaskRecord, expectedRevision: number | null): Promise<void>;
  withLock<T>(id: string, operation: () => Promise<T>): Promise<T>;
}
export interface ResearchTaskOptions {
  host: ResearchTaskHost;
  store?: ResearchTaskStorage;
  signal?: AbortSignal;
}
export interface CreateResearchTaskRequest {
  plan: FollowupPlanRequest;
  totalTimeoutSeconds?: number;
}
export type ResearchActionDefinition = FollowupAction;
