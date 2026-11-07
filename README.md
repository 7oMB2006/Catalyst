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

Catalyst reads individual sources and returns their evidence, coverage and source-local analysis. The host agent (harness) owns conversation context, source selection, comparisons and answers across sources. Long-video checkpoints preserve progress within one source. Bounded Bilibili search returns candidates for the host to select; cross-platform search is not implemented.

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

## Read a selected link

Give the host a link and a question. For a complete selected video or Bilibili part, use the segmented reader without manually choosing an opening window:

```text
analyze_long_video_url({
  url: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17",
  question: "Which self-attention mechanisms does this lesson introduce, and what does each address?",
  mode: "language",
  language: "en",
  max_detail_windows: 0,
  timeout_seconds: 1800
})
```

The reader plans every overview window in the selected source interval. A Bilibili `p` selects one part, not the whole collection. Defaults are 600-second segments and at most 12 overview segments; a larger plan is rejected before media acquisition rather than silently sampling the beginning. Use `vision` or `multimodal` when the question needs pictures, diagrams or visible actions. See [long-video reading and limits](./docs/long-video.md).

| Mode | Evidence used |
| --- | --- |
| `language` | Available platform captions first; otherwise audio/ASR. Video frames are excluded. |
| `vision` | Video with its audio removed. Visible text remains valid visual evidence. |
| `multimodal` | Original audio and visual channels, with explicit ASR for long-video language evidence. |

Overview media is prepared at up to 360p/1fps, and detail media at up to 720p/5fps. Complete overview coverage does not establish that every frame or formula was read. Defaults are a 512 MiB cumulative acquired-file budget, a 32 MiB prepared upload limit, and a 900-second shared deadline (configurable up to 1,800 seconds; the host timeout must be longer). Budget or deadline failures retain partial reports. Media is acquired by source window.

### Save and resume a reading

Long-video reading saves progress locally by default (`save_session: true`). After a timeout, cancellation or server restart, the host can resume unfinished work for the same question:

```text
resume_long_video_research({
  session_id: "<session.id from the original result>",
  timeout_seconds: 1800,
  window_timeout_seconds: 300
})

get_research_session({ session_id: "<session.id>" })
list_research_sessions({})
delete_research_session({ session_id: "<session.id>" })
```

Completed overview and detail segments keep their reports, captions/ASR and citations. Resume processes unfinished segments, then rebuilds the source-local answer and coverage report. Successful segments are not downloaded, transcribed or analyzed again. Runtime deadlines and the acquired-file budget start afresh; `session.reused_segments` and `session.processed_segments` distinguish retained work from this invocation.

`get` and `list` make no source or provider calls. Records live in `~/.catalyst/sessions`, or `CATALYST_SESSION_DIR`, and contain sanitized results and progress without media, credentials or signed acquisition URLs. Set `save_session: false` for an unsaved run. Resume keeps the original question, source/part, mode, language, quality and window plan. An optional fresh `url` must still resolve to the same source. See [session storage and recovery](./docs/research-sessions.md).

## Let the host manage the conversation

For example, the user provides tutorials A and B and asks how their Agent designs differ. The host reads each link, keeps the evidence and compares it in its own context. If the user later supplies tutorial C, the host reads C and combines its evidence with the retained A/B results. Catalyst does not need a separate multi-source task or an “append source” operation.

For a new question such as “turn tutorial A into minimum implementation steps,” the host can reason over the retained captions, ASR, body text or OCR. If a saved video's evidence is no longer in context, `get_research_session` retrieves it without rereading the source. The host retains note results itself. Missing information can trigger a selected new time window or image-page read. Earlier generated answers and visual interpretations are not raw source text; a new question requiring visual inspection needs the relevant pictures or clips to be checked.

The default server exposes 11 tools:

| Purpose | Tools |
| --- | --- |
| Find candidates | `discover_bilibili_videos` |
| Read one source | `analyze_long_video_url`, `analyze_video_url`, `analyze_xiaohongshu_note` |
| Recover saved video progress | `resume_long_video_research`, `get_research_session`, `list_research_sessions`, `delete_research_session` |
| Existing BVR tools | `analyze_bilibili_video`, `analyze_video`, `inspect_video_window` |

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

## Inspect a selected video window

When the host needs a specific visual check, it can select an original source interval:

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

This is an explicitly chosen interval, not the default scope for reading a pasted link. Provide `start_seconds` and `end_seconds` together. For media longer than 900 seconds, the generic tool requires a window of at most 900 seconds; otherwise it returns `WINDOW_REQUIRED`. Caption-only language reading has separate text limits. Use `inspect_video_window` with an absolute `video_path` and source-time bounds for a local file; `analyze_video` analyzes a local file visually.

The generic video tool uses an available source by default and records its actual quality. Visual and multimodal acquisition prefer formats at or below 1080p. Its media-file budget defaults to 256 MiB, configurable through `CATALYST_MAX_MEDIA_MB`; acquisition can download the whole source before cutting the requested interval. Independent calls have no shared media or transcription cache. To impose a quality threshold, supply:

```text
source_quality: { profile: "high", on_unavailable: "error" }
```

Profiles inherited from BVR are `standard` (1080p30), `high` (1440p30), and `custom` with explicit resolution/fps. A missing target fails by default; `on_unavailable: "warn"` allows a reported fallback. Requesting higher quality cannot recover detail absent from the original video.

For Xiaohongshu, paste an original note URL, official `xhslink.com`/`xhslink.cn` short URL, or share text containing one link. Retain original share parameters. HTTP short links are upgraded to HTTPS; public results hide acquisition parameters and signed image/media URLs. Collections and live content remain unsupported. An empty video-format list does not establish that a source is an image note; use the dedicated note entry below.

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

The default image-note `vision`/`combined` path requires provider-native JSON Schema output support on the configured model and channel. Each batch returns one observation per image in input order; Catalyst binds these to the original page numbers. Invalid output rejects that batch while retaining completed batches and OCR. This validates output structure and page mapping, not observation accuracy. No new MCP parameters are needed; see [model compatibility](./docs/model-compatibility.md#2026-11-07--image-note-native-structured-output) for tested scope and provider details.

The final image-note model call requests one set of cited answer points. Catalyst assembles `analysis` from accepted findings, original page locators and per-point limitations, so substantive content cannot remain only in Findings. Findings remain `unverified`. With no accepted findings, `analysis` is `null` and the partial result retains its evidence; uncited free text is not used as a fallback. An independent `analysis` returned by an older executor no longer contributes to an image-note answer, so necessary qualifications belong in each finding's `limitations`. Confirmed video notes keep the existing video workflow.

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

## Earlier workflow compatibility

The task manager, comparison, follow-up planner and new-question tools are retained through a separate compatibility server. They are absent from the default `dist/index.js` tool list. Existing integrations that require them can explicitly use this MCP entry instead:

```bash
node /absolute/path/to/Catalyst/dist/legacy-research.js
```

This entry exposes the 11 source tools plus the earlier nine workflow tools. The task CLI (`npm run task -- …`) connects to it automatically. Existing task and session records are neither migrated nor deleted; local `show`, `list` and `delete` commands continue to work. For new host integrations, keep conversation state, source selection, comparisons and new-question answering in the harness.

The retained contracts are documented in [link tasks](./docs/link-research.md), [task follow-up](./docs/task-followup.md), [comparison](./docs/comparison.md), [follow-up planning](./docs/research-followup-plan.md), [selected-round tasks](./docs/research-tasks.md), and [long-video follow-up](./docs/long-video-followup.md).

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
