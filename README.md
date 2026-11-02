# Catalyst

[简体中文](./README.zh-CN.md) · English

Catalyst provides video research and Xiaohongshu image/text note research for existing agents, with explicit evidence sources, original image-page numbers or source-time ranges, availability states, and analysis limits.

Catalyst evolves from [Bilibili Video Research](https://github.com/7oMB2006/Bilibili-Video-Research), retaining its Git history and existing BVR tools. This is an early preview, installed from source.

## Preview scope

| Source | Scope |
| --- | --- |
| Bilibili | Public video metadata, available captions or audio fallback, media research, and optional sampled comments. Access and source quality depend on the video and authorized account. |
| YouTube | Public video metadata, available manual or automatic JSON3 captions, and media research. Comment sampling reports `unsupported` in this preview. |
| Xiaohongshu (experimental) | A dedicated note entry reads body text, per-page OCR and image content, routing confirmed videos to the existing video workflow. Accepts note/share URLs and copied share text. Platform captions and comments remain unsupported. |
| Local files | Existing visual analysis and silent-window inspection tools. |
| Douyin | Acquisition research candidate; no preview support claim. |

Discovery, cross-platform search, and long-running task scheduling are later work. The host agent owns the overall task and conversation.

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

The new tool uses an available source by default, recording its actual quality. Visual and multimodal acquisition prefer formats at or below 1080p; inspect the reported dimensions when a source fallback is used. The default media-file budget is 256 MiB, configurable through `CATALYST_MAX_MEDIA_MB`. Acquisition can download the entire source before cutting the requested interval, and this preview has no cross-request media or transcription cache. To impose a quality threshold, supply `source_quality`, for example:

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

macOS prefers local OCR through an available Swift/Vision runtime; other environments or unavailable local runtimes send images to the configured model provider for OCR. `CATALYST_OCR_ENGINE=provider` or `apple_vision` selects an explicit path. OCR may misread characters; use vision/combined for layouts and arrows. Images are limited to 12 MiB each and 128 MiB total, with at most four images per model batch. Note-page fetching currently uses anonymous access; `XIAOHONGSHU_COOKIES_*` applies to the video downloader.

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
