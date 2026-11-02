import type { Capability, ExecutionContext, Finding, ResearchFailure, ResearchMode, ResearchResult } from "./contracts.js";

/** Internal URLs retain acquisition parameters and never enter public results. */
export interface NotePage { index: number; url: string; width?: number; height?: number }
export interface XiaohongshuNoteSource {
  id: string; sourceUrl: string; canonicalUrl: string; title: string; description: string;
  uploader?: string; contentType: "image_note" | "video_note"; pages: NotePage[];
}
export interface AcquiredNotePage { index: number; path: string; width?: number; height?: number }
export interface NoteImages { directory: string; pages: AcquiredNotePage[]; bytes: number; dispose(): Promise<void> }
export interface PageText { page: number; text: string; method: "apple_vision" | "provider_ocr"; warnings: string[] }
export interface NoteResearchRequest {
  url: string; question: string; mode?: "text" | "vision" | "combined"; language?: string;
  startPage?: number; endPage?: number; timeoutSeconds?: number;
}
export interface NoteEvidence {
  id: string; kind: "note_text" | "image_text" | "image_visual";
  source: { platform: "xiaohongshu"; note_id: string; url: string; origin: string };
  page: number | null; content?: string; limitations: string[];
}
export interface NoteResearchResult {
  schema_version: "1.0"; status: "complete" | "partial" | "unavailable";
  note: null | { platform: "xiaohongshu"; id: string; sourceUrl: string; canonicalUrl: string; title: string; description: string; uploader?: string; contentType: "image_note"; imageCount: number };
  request: NoteResearchRequest;
  capabilities: { body: Capability; images: Capability; ocr: Capability; comments: Capability };
  evidence: NoteEvidence[]; findings: Finding[]; analysis: string | null; warnings: string[]; errors: ResearchFailure[];
  processing: { duration_ms: number; stage_durations_ms: Record<string, number>; provider: string | null; model?: string; usage: null; download_bytes?: number; total_pages?: number; selected_pages?: number[]; processed_pages?: number[] };
}
export interface XiaohongshuResearchResult {
  schema_version: "1.0"; status: "complete" | "partial" | "unavailable";
  content_type: "image_note" | "video_note" | "unknown";
  result: NoteResearchResult | ResearchResult | null;
  errors: ResearchFailure[];
}
export interface NoteDependencies {
  resolve(request: NoteResearchRequest, context: ExecutionContext): Promise<XiaohongshuNoteSource>;
  acquire(source: XiaohongshuNoteSource, pages: number[], context: ExecutionContext): Promise<NoteImages>;
  ocr(pages: AcquiredNotePage[], context: ExecutionContext, language?: string): Promise<PageText[]>;
  analyzeImages(paths: string[], prompt: string, context: ExecutionContext, language?: string): Promise<string>;
  analyzeText(prompt: string, context: ExecutionContext, language?: string): Promise<string>;
  video?(url: string, question: string, mode: ResearchMode, context: ExecutionContext, language?: string): Promise<ResearchResult>;
}
