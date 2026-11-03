import type { ExecutionContext, MediaAsset, ResearchRequest, ResearchResult, SourceContext, VideoIdentity } from "./contracts.js";

export interface SourceWindow { start_seconds: number; end_seconds: number }
export interface LongVideoRequest extends ResearchRequest {
  segmentSeconds?: number;
  maxSegments?: number;
  maxDetailWindows?: number;
  detailWindowSeconds?: number;
  maxDownloadMB?: number;
  windowTimeoutSeconds?: number;
}
export interface LongVideoSegment {
  id: string;
  phase: "overview" | "detail";
  window: SourceWindow;
  status: "pending" | "complete" | "partial" | "failed";
  basis: "captions" | "audio" | "video" | "audio_video";
  evidence_ids: string[];
  analysis: string | null;
  relevance_score?: number;
  proposed_focus_offset_seconds?: number;
  error?: string;
}
export interface LongVideoResult extends ResearchResult {
  plan: null | {
    strategy: "segmented_overview_then_detail";
    requested_window: SourceWindow;
    segment_seconds: number;
    overview_windows: SourceWindow[];
    max_detail_windows: number;
    detail_window_seconds: number;
    max_download_bytes: number;
    window_timeout_seconds: number;
  };
  segments: LongVideoSegment[];
  coverage: {
    overview: SourceWindow[];
    detail: SourceWindow[];
    unreviewed: SourceWindow[];
    overview_complete: boolean;
    limitations: string[];
  };
}
export interface PreparedWindow { path: string; dispose(): Promise<void> }
export interface LongVideoDependencies {
  resolve(request: ResearchRequest, context: ExecutionContext): Promise<SourceContext>;
  acquireWindow(video: VideoIdentity, request: ResearchRequest & { maxAcquiredBytes?: number }, context: ExecutionContext): Promise<MediaAsset>;
  prepareWindow(path: string, mode: ResearchRequest["mode"], detail: "low" | "default", context: ExecutionContext): Promise<PreparedWindow>;
  transcribe(path: string, context: ExecutionContext, language?: string): Promise<string>;
  analyzeMedia(path: string, prompt: string, detail: "low" | "default", context: ExecutionContext, language?: string): Promise<string>;
  analyzeText(prompt: string, context: ExecutionContext, language?: string): Promise<string>;
}
