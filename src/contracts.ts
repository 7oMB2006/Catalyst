import type { MediaDetail } from "./video-analysis.js";
import type { SourceQualityReport, SourceQualityRequest } from "./media-quality.js";

export type Platform = "bilibili" | "youtube" | "xiaohongshu";
export type ResearchMode = "language" | "vision" | "multimodal";
export type Availability = "available" | "absent" | "unsupported" | "disabled" | "not_requested" | "error" | "auth_required" | "blocked" | "unknown";
export interface Capability { status: Availability; reason?: string }
export interface Capabilities { metadata: Capability; captions: Capability; media: Capability; comments: Capability }
export interface VideoIdentity {
  platform: Platform;
  id: string;
  partId?: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  uploader?: string;
  durationSeconds: number;
  metadata?: Record<string, unknown>;
}
export interface CaptionCue { start: number; end: number; content: string }
export interface Captions {
  status: Availability;
  kind: "manual" | "automatic" | "unknown";
  language?: string;
  cues: CaptionCue[];
  reason?: string;
}
export interface CommunityComment { id?: string; text: string; author?: string; likes?: number }
export interface SourceContext {
  video: VideoIdentity;
  captions: Captions;
  comments: { status: Availability; items: CommunityComment[]; reason?: string };
  capabilities: Capabilities;
  warnings: string[];
}
export interface ResearchRequest {
  url: string;
  question: string;
  mode: ResearchMode;
  mediaDetail?: MediaDetail;
  includeComments?: boolean;
  sourceQuality?: SourceQualityRequest;
  language?: string;
  startSeconds?: number;
  endSeconds?: number;
  timeoutSeconds?: number;
}
export interface ExecutionContext { signal: AbortSignal; deadlineMs: number }
export interface MediaAsset {
  path: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  formatId?: string;
  bytes?: number;
  quality?: SourceQualityReport;
  dispose(): Promise<void>;
}
export interface PlatformAdapter {
  platform: Platform;
  supports(url: URL): boolean;
  resolve(request: ResearchRequest, context: ExecutionContext): Promise<SourceContext>;
  acquire(video: VideoIdentity, request: ResearchRequest, context: ExecutionContext): Promise<MediaAsset>;
}
export interface Evidence {
  id: string;
  kind: "metadata" | "caption" | "asr" | "visual" | "multimodal" | "community";
  source: { platform: Platform; video_id: string; part_id?: string; url: string; origin: string };
  time_range: { start_seconds: number; end_seconds: number } | null;
  time_basis: "source" | "none";
  precision: "caption_cue" | "requested_window" | "unknown";
  content?: string;
  data?: Record<string, unknown>;
  language?: string;
  limitations: string[];
}
export interface Finding {
  id: string;
  statement: string;
  evidence_ids: string[];
  verification: "unverified";
  limitations: string[];
}
export interface ResearchFailure { code: string; stage: string; message: string; retryable: boolean }
export interface ResearchResult {
  schema_version: "1.0";
  status: "complete" | "partial" | "unavailable";
  video: VideoIdentity | null;
  request: ResearchRequest;
  capabilities: Capabilities;
  evidence: Evidence[];
  findings: Finding[];
  analysis: string | null;
  warnings: string[];
  errors: ResearchFailure[];
  processing: {
    duration_ms: number;
    stage_durations_ms: Record<string, number>;
    provider: string | null;
    model?: string;
    usage: null;
    download_bytes?: number;
    source_quality?: Record<string, unknown>;
  };
}
