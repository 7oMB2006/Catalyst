# Catalyst

[简体中文](./README.zh-CN.md) · English

Catalyst provides Bilibili candidate discovery, video research and Xiaohongshu image/text note research for existing agents, with explicit evidence sources, original image-page numbers or source-time ranges, availability states, and analysis limits.

Catalyst evolves from [Bilibili Video Research](https://github.com/7oMB2006/Bilibili-Video-Research), retaining its Git history and existing BVR tools. This is an early preview, installed from source.

## Preview scope

| Source | Scope |
| --- | --- |
| Bilibili | Experimental candidate discovery, public video metadata, available captions or audio fallback, media research, and optional sampled comments. Access and source quality depend on the platform, video and authorized account. |
| YouTube | Public video metadata, available manual or automatic JSON3 captions, and media research. Comment sampling reports `unsupported` in this preview. |
| Xiaohongshu (experimental) | A dedicated note entry reads body text, per-page OCR and image content, routing confirmed videos to the existing video workflow. Accepts note/share URLs and copied share text. Platform captions and comments remain unsupported. |
| Local files | Existing visual analysis and silent-window inspection tools. |
| Douyin | Acquisition research candidate; no preview support claim. |

Discovery starts with bounded Bilibili candidate search. For selected links, persistent research tasks connect initial reading, saved progress, explicit continuation and comparison. A deterministic follow-up planner also provides individual reading or search suggestions. The host agent owns query planning, source selection and the overall conversation. Cross-platform search, autonomous research loops and background scheduling are later work.

## Installation

Requirements:

- Node.js 24 or newer.
- Python 3.10 or newer when using a Python-based yt-dlp distribution.
- A working yt-dlp installation with EJS for YouTube, plus FFmpeg.
- A StepFun or Gemini credential for model analysis.

```bash
git clone https://github.com/7oMB2006/Catalyst.git
cd Catalyst
npm ci
npm run build
cp .env.example .env
# Configure the provider and any external binary paths in .env.
npm run doctor
npm test
```

On Windows, use `Copy-Item .env.example .env` in place of `cp`; use `py -3 -m pip` or a configured `python -m pip` if `python3` is not available.

Bundled media dependencies are used when available. For an external downloader, install the official Python distribution and set its executable path:

```bash
python3 -m pip install 'yt-dlp[default]'
```

```env
YTDLP_PATH=/absolute/path/to/yt-dlp
# Set this when the selected downloader needs a specific Python interpreter.
YTDLP_PYTHON=/absolute/path/to/python
FFMPEG_PATH=/absolute/path/to/ffmpeg
```

The inherited `yt-dlp-exec` package is optional. Its install hook invokes `python`; when that command is absent or too old, npm can omit this optional dependency. Use an external yt-dlp installation through `YTDLP_PATH`, or make Python >=3.10 available as `python` in the installation environment if you want the optional bundle. `YTDLP_PYTHON` controls runtime execution; it does not change that install hook. FFmpeg's bundled binary may also be unavailable on a particular platform; `FFMPEG_PATH` is the explicit fallback.

`npm run doctor` runs the compiled `dist/doctor.js`, so build first. It checks local executable versions and whether a provider credential is configured. It does not contact video platforms or providers, read browser cookies, or test account balance. EJS detection can be inconclusive for standalone binaries; review any warning before a YouTube request. See the [upstream EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

## Start the MCP server

```bash
npm start
```

This starts the compiled stdio server. In an MCP host, use `node` as the command and the absolute path to `dist/index.js` as its argument. Set `DOTENV_CONFIG_PATH` to the absolute path to the local `.env` file when the host starts in a different directory. Configure the host's tool timeout to cover the requested research timeout and startup overhead.

Provider credentials belong in the process environment or local `.env`, rather than the host's checked-in configuration. `CODEX_VIDEO_PROVIDER` remains the historical provider selector: `stepfun` by default, or `gemini`.

## Start from links and continue later

Give the host one to three Bilibili, YouTube or Xiaohongshu links and a question. It can start research without existing result JSON or manually selected time offsets:

```text
start_research_task({
  urls: ["https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17"],
  question: "Which self-attention mechanisms does this lesson introduce?",
  mode: "language"
})
```

The result includes `task.id`, source progress and retained evidence. If work remains, the host maps a later request to continue to this ID:

```text
continue_research_task({ task_id: "<task.id>" })
get_research_task({ task_id: "<task.id>" })
list_research_tasks({})
delete_research_task({ task_id: "<task.id>" })
```

A single source works on its own. Video research plans the full selected video or Bilibili part with bounded segments, rather than a default opening sample. Image notes retain original page numbers and separate text/visual coverage. Each invocation reads a source at most once, prioritizing unread links; starting runs up to three steps, and continuation accepts `max_steps: 1–4` (default three). When 2–3 materials are available, a step can compare their retained evidence. `comparison_current` states whether the saved comparison includes the latest reading results.

The default persistent allowance is 1,800 seconds, with 240 seconds reserved per source call and up to 120 per comparison. Full declared timeouts are reserved without refunds; continuing does not reset the allowance. Completed work remains saved, while an unconfirmed call stops for inspection. There is no background continuation. `get`/`list` make no source or provider calls; deleting a task leaves its video sessions intact.

The CLI provides `npm run task -- start /absolute/path/input.json` with camelCase `urls`, `question` and optional budgets, followed by `npm run task -- continue TASK_UUID`. See [link research, result scope, budgets and CLI inputs](./docs/link-research.md), including fresh share URLs and the limits of accumulated image-note reports.

## Ask another question about the saved sources

After comparing two tutorials, ask the host to turn their documented approach into minimum implementation steps:

```text
follow_up_research_task({
  task_id: "<previous task.id>",
  question: "Using these tutorials, list the minimum implementation steps and cite the source for each step.",
  mode: "language"
})
```

This creates a child with the same 1–3 sources, an independent budget and a snapshot of original captions, ASR, note body and OCR. The parent stays unchanged. Language follow-ups answer only from retained text, without source requests, downloads, ASR, OCR or automatic reading of parent gaps. Old generated answers and visual observations are excluded. Explicit `vision` or `multimodal` performs new visual inspection for the new question.

Use the child's `task.id` to continue or read it; `answer` and `answer_current` identify the new cited answer and its freshness. The child remains usable after deleting the parent or its sessions. CLI: `npm run task -- follow-up PARENT_TASK_UUID /absolute/path/input.json`, with a new `question` and optional settings in camelCase. See [task follow-up, evidence scope and budget boundaries](./docs/task-followup.md).

## Discover Bilibili candidates

```text
discover_bilibili_videos({
  question: "Which approaches reduce the computation required by self-attention?",
  queries: ["高效注意力 Linformer", "稀疏注意力 原理"],
  max_candidates: 10,
  timeout_seconds: 30
})
```

The tool returns search metadata and ranked source links, with the originating queries and original result positions. Candidates are marked `content_status: "not_read"` and `media_access: "not_checked"`; search snippets and ordering do not establish what a video contains or whether its media can be acquired. Results without an explicit part retain `part_number: null`; search durations have not been verified for a selected part.

The host supplies up to three short queries. If omitted, the question itself is the single query; a question longer than 200 characters requires explicit short queries. Defaults are ten candidates and a 30-second shared deadline. Each query requests one page of up to twenty rows. The tool performs no model calls, ASR, media downloads, automatic retries or browser-cookie reads, and needs no model credential. Select a candidate and pass its URL to an existing research tool, which revalidates source and part identity before reading content.

This is an experimental anonymous Bilibili Web search path, not a stable official API. Access restrictions can produce partial or unavailable results; blocking, authentication requirements and rate limits stop remaining queries. Every result declares `search_exhaustive: false`, and reports candidates omitted by the requested return limit. See the [discovery design, references and acceptance criteria](./docs/discovery.md).

## Compare selected research material

After reading sources, the host can compare 2–3 selected results for shared statements, differences and evidence gaps. Video results, Xiaohongshu image/text research and saved long-video sessions can be combined:

```text
compare_research_materials({
  question: "Where do these sources agree or differ about the conditions for efficient attention?",
  materials: [
    { kind: "video", result: <complete existing video research result> },
    { kind: "xiaohongshu", result: <complete existing Xiaohongshu research result> }
  ],
  language: "en",
  max_comparisons: 6,
  timeout_seconds: 120
})
```

Each comparison retains its material identity, original evidence IDs and video times or image-page numbers. Code prepares contiguous source excerpts; the model selects excerpt IDs, and code attaches the original quote and source. This avoids having the model rewrite or join quotations while preserving exact-substring validation. Unaddressed topics and insufficient evidence have separate states; repeated sources do not add independent corroboration, and source independence remains unestablished.

Comparison reads supplied results and makes at most one text-provider call. Source captions, ASR, body text and OCR can answer a new question; prior visual observations are reused only for the same original question, and old final answers are excluded. Input is limited to 2 MiB and the prepared prompt to 200,000 characters; excess material is rejected explicitly. Valid citations establish structure rather than semantic correctness, and comparisons remain `unverified`. See [comparison design and references](./docs/comparison.md) for material types and session references.

## Plan bounded follow-up research

The host can check 1–3 existing results or saved sessions for missing coverage and ask for typed calls to existing tools:

```text
plan_research_followup({
  question: "How does this lesson explain the self-attention computation?",
  materials: [
    { kind: "video", result: <complete existing video research result> }
  ],
  evidence_requirement: "original",
  coverage_target: "requested",
  max_actions: 3,
  max_rounds: 2,
  round: 1,
  attempted_action_keys: []
})
```

The planner returns gaps, action keys, source time windows or original image pages, and validated tool arguments. It performs no model calls, platform requests, media acquisition, execution or persistence. The host executes selected `next_actions`, retains the returned evidence, and supplies attempted keys and an updated round when planning again. Defaults limit a plan to three actions across two sources. New video actions cover up to 180 seconds and note actions up to four pages; saved-session resumes may process multiple original windows within their own timeout and acquisition budget.

`original` inherits each material's original evidence mode. `requested` checks its original requested scope; explicitly choose `coverage_target: "source"` to extend to a known full video or note. Different questions invalidate prior question-specific visual coverage, while original source text remains reusable. Repeated material coverage is merged. A comparison's `single_source` or `not_addressed` state does not itself trigger more research; extra Bilibili discovery requires explicit `search_queries`. Structured source-access restrictions and attempted action keys stop automatic retry suggestions; provider authentication errors do not establish source blocking. See [follow-up planning design, budgets and references](./docs/research-followup-plan.md).

## Execute one selected follow-up round

The lower-level v1 reference host saves an immutable follow-up plan and executes only explicitly selected action keys through the existing MCP server. Link tasks above use v2; CLI `show`, `list` and `delete` manage both generations:

```bash
npm run build
npm run task -- create /absolute/path/task-input.json
npm run task -- run TASK_UUID SELECTED_ACTION_KEY
npm run task -- run TASK_UUID
```

The input contains `plan` (the TypeScript planner request with camelCase settings and 2–3 existing materials), plus optional `totalTimeoutSeconds`. The first run fixes the selected keys; later runs continue that selection and skip recorded results. Intent and timeout allowance are saved before dispatch. Lost acknowledgements or interrupted calls become `unknown` and require host inspection; they are never automatically replayed. Results retain `partial` and `unavailable` research states.

Tasks live in `~/.catalyst/tasks` or `CATALYST_TASK_DIR`, separately from video sessions. Defaults reserve each action's entire timeout against a persistent 900-second allowance, without refunds; this is not a monetary or download budget. Use `show`, `list` and `delete` to manage records. Hosts can embed the exported runner using their own MCP connection. Source selection, subsequent planning and comparison remain with the host. See [task inputs, recovery boundaries and design references](./docs/research-tasks.md).

## Research a video

```text
analyze_video_url({
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  question: "Which animals are visible, and what features can actually be seen?",
  mode: "vision",
  media_detail: "default",
  include_comments: false,
  start_seconds: 0,
  end_seconds: 15,
  timeout_seconds: 240
})
```

| Mode | Evidence used |
| --- | --- |
| `language` | Available platform captions first; otherwise audio/ASR. Video frames are excluded. |
| `vision` | Video with its audio removed. Visible text remains valid visual evidence. |
| `multimodal` | Original audio and visual channels. |

Provide `start_seconds` and `end_seconds` together. For media longer than 900 seconds, the generic tool requires an explicit window of at most 900 seconds; otherwise it returns `WINDOW_REQUIRED`. Caption-only language research is not subject to this media-upload limit. The legacy BVR entry retains its coarse/detail pass for long visual videos. `language` can select a preferred caption/ASR language. Actual capabilities and failures are reported for each source; an unavailable comment path does not establish that video research failed.

For long lectures, courses, and interviews, use `analyze_long_video_url`. It plans every overview window in the selected source interval, then takes closer looks at relevant clips. Overview, detail, and unreviewed intervals are reported separately:

```text
analyze_long_video_url({
  url: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17",
  question: "Which self-attention mechanisms does this lesson introduce, and what does each address?",
  mode: "multimodal",
  language: "en",
  segment_seconds: 600,
  max_segments: 12,
  max_detail_windows: 2,
  timeout_seconds: 1800
})
```

Overview media is prepared at up to 360p/1fps, and detail media at up to 720p/5fps. Complete overview coverage does not establish that every frame or formula was read. Defaults are a 512 MiB cumulative acquired-file budget, a 32 MiB prepared upload limit, and a 900-second shared deadline (configurable up to 1,800 seconds; the host timeout must be longer). Budget or deadline failures retain partial reports. Media is acquired by source window. See the [long-video design and acceptance record](./docs/long-video.md).

### Save and resume long-video research

Long-video research saves progress locally by default (`save_session: true`). The result's `session.id` identifies the record. After a timeout, cancellation, or server restart, resume the same research question:

```text
resume_long_video_research({
  session_id: "<session.id from the original result>",
  timeout_seconds: 1800,
  window_timeout_seconds: 300
})
```

Completed overview and detail segments retain their reports, captions/ASR, and citations. Resume processes unfinished segments, then synthesizes an updated answer and coverage report. Completed segments are not downloaded, transcribed, or analyzed again. The per-request deadline and acquired-file budget start afresh; `session.reused_segments` and `session.processed_segments` distinguish reused work from this invocation.

Use `list_research_sessions` to find records, `get_research_session({ session_id })` to inspect one, and `delete_research_session({ session_id })` to remove one. Records live in `~/.catalyst/sessions`, or the directory set by `CATALYST_SESSION_DIR`. They contain sanitized results and progress, without media files, credentials, or signed acquisition URLs. Set `save_session: false` on the original long-video call for an unsaved run.

Resume keeps the original question, selected source/part, mode, language, quality, and window plan. Only runtime deadlines and the acquired-file budget may change. An optional `url` can supply a fresh original share link when access requires it; the resolved source must still match, and access parameters are not saved. There is no automatic background continuation. See [research-session storage and acceptance criteria](./docs/research-sessions.md).

### Ask another question about the same video

Create a separate research record from a saved session's completed overview captions or ASR:

```text
follow_up_long_video_research({
  session_id: "<session.id from the original result>",
  question: "How do the two attention mechanisms in this lecture differ?",
  mode: "language"
})
```

The follow-up reuses source text, then reassesses relevance and produces new reports and an answer. It retains the parent record. Language follow-ups perform no media acquisition or ASR, but still call the text model. Missing source text remains an explicit gap.

Use `mode: "multimodal"` to select new detail windows from the language analysis and inspect their actual audio/video. Overview coverage remains language-only; detail windows incur new acquisition, ASR, and media analysis. Language mode requires `max_detail_windows: 0` (the default); multimodal mode accepts `1–4` (default `2`). The source interval, overview plan, language, and quality are inherited. Configuration and source identity must remain compatible.

The new `session.id` can be read, resumed, or deleted independently. `follow_up` identifies the parent revision and copied language evidence. On the first follow-up call, `session.reused_segments` is `0` because all question-specific reports are new. See the [follow-up design and acceptance criteria](./docs/long-video-followup.md).

The generic video tool uses an available source by default, recording its actual quality. Visual and multimodal acquisition prefer formats at or below 1080p; inspect the reported dimensions when a source fallback is used. The default media-file budget is 256 MiB, configurable through `CATALYST_MAX_MEDIA_MB`. Generic acquisition can download the entire source before cutting the requested interval. Independent research calls have no shared media or transcription cache; saved long-video sessions support explicit resume and follow-up reuse as described above. To impose a quality threshold, supply `source_quality`, for example:

```text
source_quality: { profile: "high", on_unavailable: "error" }
```

Profiles inherited from BVR are `standard` (1080p30), `high` (1440p30), and `custom` with explicit resolution/fps. A missing target fails by default; `on_unavailable: "warn"` allows a reported fallback. Requesting higher quality cannot recover detail absent from the original video.

For Xiaohongshu, paste an original note URL, official `xhslink.com`/`xhslink.cn` short URL, or share text containing one link. Retain original share parameters. HTTP short links are upgraded to HTTPS; public results hide acquisition parameters and signed image/media URLs. Collections and live content remain unsupported. An empty video-format list does not establish that a source is an image note; use the dedicated note entry for Xiaohongshu research.

## Research a Xiaohongshu image/text note

```text
analyze_xiaohongshu_note({
  url: "https://xhslink.cn/o/Af8twEpdOVh",
  question: "What Agent architecture does the author describe? Cite original image pages.",
  mode: "text",
  language: "en"
})
```

The entry confirms the actual source type. For image notes, `text` reads the body and per-page OCR, `vision` inspects pictures and diagrams, and `combined` uses both. Confirmed video notes use the existing language/vision/multimodal workflow respectively. Image-note evidence distinguishes platform body, generated OCR and model visual observations, citing original 1-based image pages without invented durations or timestamps.

All images are selected by default, up to 50 per request. Longer notes require an inclusive `start_page`/`end_page` pair; cover-only processing never counts as full-note coverage. A page selection excludes the full-note body. Missing or unreadable pages, OCR failures and invalid citations preserve acquired evidence as partial results.

macOS prefers local OCR through an available Swift/Vision runtime; other environments or unavailable local runtimes send images to the configured model provider for OCR. `CATALYST_OCR_ENGINE=provider` or `apple_vision` selects an explicit path. OCR may misread characters; use vision/combined for layouts and arrows. Images are limited to 12 MiB each and 128 MiB total, with at most four images per model batch. AVIF responses are normalized to a single-frame PNG using FFmpeg before OCR or visual analysis; decoded images are capped at 40 million pixels, and normalized files obey the same byte limits. Note-page fetching currently uses anonymous access; `XIAOHONGSHU_COOKIES_*` applies to the video downloader.

## Evidence and results

The generic tool returns structured results together with readable text. The result records video identity, requested mode/window, per-capability states, evidence, findings, warnings, errors, and processing information.

- Caption evidence retains source cue times and language.
- A media window records the interval supplied for analysis. It does not give every generated sentence a verified timestamp.
- Model findings remain `verification: "unverified"`. References to real evidence IDs validate the reference structure, not the truth of each statement.
- Frame numbers and precise times generated by a model are not deterministic extraction records. Missing or unconfirmed precision stays explicit.
- `complete`, `partial`, and `unavailable` distinguish an analysis response from retained evidence or a failure. Unavailable provider usage and monetary cost remain unknown.

Review supporting source material before relying on a specific claim. The [architecture](./docs/architecture.md) and [validation record](./docs/validation.md) describe these boundaries.

## BVR compatibility

The existing tools remain available:

- `analyze_bilibili_video`: the Bilibili-specific tool and its legacy text/provenance format.
- `analyze_video`: visual analysis of a local video.
- `inspect_video_window`: visual analysis of a local source interval.

The legacy Bilibili tool retains its strict default 1080p30 quality policy. The generic tool's default is available source quality. Existing `STEPFUN_*`, `GEMINI_*`, and `BILIBILI_*` settings remain supported.

Authentication is explicit and platform-scoped. Set an authorized cookies file or browser source only for its intended platform; adapters do not reuse another platform's credentials. Xiaohongshu uses `XIAOHONGSHU_COOKIES_FILE` or `XIAOHONGSHU_COOKIES_FROM_BROWSER` when explicitly configured. Public metadata, selected captions/audio/video, and optional community content may be sent to the configured model provider.

## Development

```bash
npm run dev
npm run typecheck
npm test
npm run build
```

Tests are local and do not require provider credentials or live video platforms. The compiled generic tool has been exercised on YouTube captions, a nonzero YouTube visual window, and Bilibili audio/ASR fallback. The latter returned `partial` with explicit caption access and discarded-citation warnings. These checks validate integration and citation structure, not model accuracy. Exact observations and deployment checks are listed in [validation](./docs/validation.md).

After building, a production deployment can retain `dist` and install with `npm ci --omit=dev`. Both `npm start` and `npm run doctor` then run compiled JavaScript without `tsx`; external media dependencies and provider configuration still need to pass doctor.

## License

[MIT](./LICENSE). Original BVR history and attribution are retained.
