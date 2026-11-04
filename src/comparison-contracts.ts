import type { ExecutionContext, ResearchResult } from "./contracts.js";
import type { NoteResearchResult, XiaohongshuResearchResult } from "./note-contracts.js";
export type ComparisonInput =
  | { kind: "video"; result: ResearchResult; label?: string }
  | { kind: "note"; result: NoteResearchResult; label?: string }
  | { kind: "xiaohongshu"; result: XiaohongshuResearchResult; label?: string }
  | { kind: "session"; session_id: string; label?: string };
export interface ComparisonRequest { question: string; materials: ComparisonInput[]; language?: string; timeoutSeconds?: number; maxComparisons?: number }
export interface ComparisonEvidence {
  id: string; material_id: string; original_id: string;
  kind: string; basis: "source_text" | "derived_observation";
  content: string;
  locator: { url: string; platform: string; content_id: string; part_id: string | null; time_range: { start_seconds: number; end_seconds: number } | null; page: number | null };
  limitations: string[];
}
export interface ComparisonMaterial {
  id: string; label: string; status: "ready" | "partial" | "unavailable";
  source_key: string | null; source_group: string | null; duplicate_of: string | null;
  title: string | null; url: string | null; original_question: string | null;
  evidence_ids: string[]; limitations: string[]; errors: Array<{ code: string; message: string }>;
}
export interface PreparedComparison { materials: ComparisonMaterial[]; evidence: ComparisonEvidence[] }
export interface ComparisonPosition {
  material_id: string; stance: "supports" | "contradicts" | "not_addressed" | "insufficient";
  citations: Array<{ evidence_id: string; quote: string }>; explanation: string;
}
export interface ComparisonRow {
  id: string; claim: string; relation: "shared" | "disputed" | "single_source" | "insufficient";
  positions: ComparisonPosition[]; limitations: string[]; verification: "unverified";
}
export interface ComparisonResult extends PreparedComparison {
  schema_version: "1.0"; status: "complete" | "partial" | "unavailable";
  question: string; comparisons: ComparisonRow[]; analysis: string | null;
  source_independence: "not_established"; warnings: string[];
  errors: Array<{ code: string; message: string }>;
  processing: { duration_ms: number; provider: string | null; model_calls: number };
}
export interface ComparisonDependencies {
  prepare(inputs: ComparisonInput[], question: string, context: ExecutionContext): Promise<PreparedComparison>;
  analyzeText(prompt: string, context: ExecutionContext, language?: string): Promise<string>;
}
