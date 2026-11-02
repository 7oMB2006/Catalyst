# Catalyst 催化剂

**简体中文** · [English](./README.md)

Catalyst 为现有 Agent 提供跨平台视频研究 MCP。围绕具体问题，它把 B 站、YouTube 和可访问的小红书视频笔记的可用字幕、音频、画面与公开上下文送入共用研究流程，并返回来源、源时间范围、获取状态和分析限制。

项目继承自 [Bilibili Video Research](https://github.com/7oMB2006/Bilibili-Video-Research)，保留原有 Git 历史与 BVR 工具。目前是从源码安装的早期预览版。

## 预览范围

| 来源 | 当前范围 |
| --- | --- |
| B 站 | 公开视频元数据、可用字幕或音频回退、媒体研究、可选采样评论。实际访问和画质取决于内容及授权账户。 |
| YouTube | 公开视频元数据、可用人工或自动 JSON3 字幕及媒体研究；本预览版的评论采样返回 `unsupported`。 |
| 小红书（实验性） | 通过原始笔记链接、官方短链或完整分享文案获取视频元数据与媒体。语言模式走音频/ASR，平台字幕和评论返回 `unsupported`；可用性取决于具体链接与会话。 |
| 本地视频 | 保留视觉分析和静音片段检查工具。 |
| 抖音 | 获取能力调查候选，尚不列为预览版支持平台。 |

跨平台搜索、问题驱动的 Discovery 和长期任务调度属于后续工作。整体任务和对话由宿主 Agent 负责。

## 安装

需要：

- Node.js 24 或更新版本。
- 使用 Python 版 yt-dlp 时，需要 Python 3.10 或更新版本。
- 可执行的 yt-dlp、YouTube 所需的 EJS，以及 FFmpeg。
- 用于模型分析的 StepFun 或 Gemini 凭据。

```bash
git clone https://github.com/7oMB2006/Catalyst.git
cd Catalyst
npm ci
npm run build
cp .env.example .env
# 在 .env 配置 Provider，以及需要覆盖的可执行文件路径。
npm run doctor
npm test
```

Windows PowerShell 使用 `Copy-Item .env.example .env` 替代 `cp`；若没有 `python3` 命令，安装 Python 包时使用 `py -3 -m pip` 或已配置的 `python -m pip`。

内置媒体依赖可用时会被采用。若需要外部下载器，可在自己的 Python 环境安装官方发行包：

```bash
python3 -m pip install 'yt-dlp[default]'
```

在 `.env` 指定实际路径：

```env
YTDLP_PATH=/absolute/path/to/yt-dlp
# 所选下载器需要特定 Python 解释器时设置。
YTDLP_PYTHON=/absolute/path/to/python
FFMPEG_PATH=/absolute/path/to/ffmpeg
```

继承的 `yt-dlp-exec` 已作为可选依赖。它的安装钩子直接运行 `python`，该命令缺失或版本过旧时，npm 可以跳过这个可选包。此时通过 `YTDLP_PATH` 使用外部 yt-dlp；若希望使用可选内置包，应让安装环境中的 `python` 指向 Python >=3.10。`YTDLP_PYTHON` 只控制运行时，不会改变安装钩子。若当前平台没有可用的内置 FFmpeg 二进制文件，使用 `FFMPEG_PATH` 显式指定。

`npm run doctor` 执行编译后的 `dist/doctor.js`，需要先完成 build。它只检查本机可执行文件和版本，以及 Provider 凭据是否已配置。它不会请求平台或模型，不读取浏览器 Cookie，也不验证账户余额。独立二进制文件中的 EJS 可能无法仅靠离线检查确认，YouTube 请求前应阅读相应提示。[yt-dlp 官方 EJS 说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

## 接入 MCP

```bash
npm start
```

这会启动编译后的 stdio MCP 服务。宿主配置的 command 使用 `node`，args 使用 `dist/index.js` 的绝对路径。宿主从其他目录启动时，将 `DOTENV_CONFIG_PATH` 设置为本地 `.env` 的绝对路径。宿主的工具超时应覆盖请求中的研究期限和启动开销。

Provider 凭据放在进程环境或本地 `.env`，避免写入会提交到仓库的宿主配置。沿用的 `CODEX_VIDEO_PROVIDER` 是历史配置名：默认 `stepfun`，也可选择 `gemini`。

## 研究视频

```text
analyze_video_url({
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  question: "画面里有哪些动物，能直接看见哪些外形特征？",
  mode: "vision",
  media_detail: "default",
  include_comments: false,
  start_seconds: 0,
  end_seconds: 15,
  timeout_seconds: 240
})
```

| 模式 | 使用的证据 |
| --- | --- |
| `language` | 优先平台字幕，无字幕时使用音频或 ASR；排除视频画面。 |
| `vision` | 上传前移除音轨；画面中可见的文字仍可作为视觉证据。 |
| `multimodal` | 同时使用原视频的声音与画面。 |

`start_seconds` 与 `end_seconds` 必须成对提供。对超过 900 秒的媒体，通用工具要求显式指定不超过 900 秒的区间，否则返回 `WINDOW_REQUIRED`；仅使用字幕的语言研究不受这个媒体上传限制。旧 BVR 入口继续保留长视觉视频的粗扫与精扫。`language` 参数可指定优先字幕或转写语言。每个平台分别报告素材能力和获取状态，评论不可用不会自动使视频研究失败。

新工具默认采用实际可用源，并记录真实质量。视觉和多模态获取优先选择不超过 1080p 的格式；发生源格式回退时，应查看实际返回的尺寸。媒体文件预算默认为 256 MiB，可通过 `CATALYST_MAX_MEDIA_MB` 调整。获取流程可能先下载完整源文件，再裁剪所选区间；本预览版没有跨请求的媒体或转写缓存。需要质量门槛时显式指定，例如：

```text
source_quality: { profile: "high", on_unavailable: "error" }
```

沿用的档位包括 `standard`（1080p30）、`high`（1440p30），以及显式给出 resolution 和 fps 的 `custom`。默认拒绝不满足目标的源；`on_unavailable: "warn"` 允许明确记录的降级。提高目标档位不能补出原视频中不存在的细节。

小红书的 `url` 可直接粘贴 `/explore/<笔记ID>`、`/discovery/item/<笔记ID>` 链接，官方 `xhslink.com`/`xhslink.cn` 短链，或包含单条链接的完整分享文案。请保留原始分享参数，获取可能依赖它们。HTTP 短链在访问前升级为 HTTPS，后续跳转仅限允许的 HTTPS 域名；公开结果会隐藏分享参数和签名媒体地址。图文笔记、合集、直播及无法确认时长的来源暂不支持。空格式列表返回 `MEDIA_UNAVAILABLE`，不能据此断言来源是图文笔记。具体链接的访问差异见[真实验证记录](./docs/validation.md)。

## 怎样理解结果

通用工具同时返回结构化结果和可读文本，记录视频身份、所请求的模式和区间、各素材能力、证据、模型结论、告警、错误及处理信息。

- 字幕证据保留源视频 cue 时间和语言。
- 媒体窗口记录送去分析的源区间，不能把每句生成内容都视为具有精确时间引用。
- 模型结论仍标记 `verification: "unverified"`。引用了有效 evidence_id 只说明引用结构成立，不能自动证明该结论正确。
- 模型生成的帧号和精确时刻不等于程序抽帧记录。无法确认的时间精度保持明确。
- `complete`、`partial`、`unavailable` 区分分析返回、部分证据和失败。未获得的 Provider usage 与费用记为未知。

需要依赖某条具体结论时，应继续复查对应来源。[架构说明](./docs/architecture.md)和[验证记录](./docs/validation.md)列出了具体边界。

## 兼容 BVR

原有工具继续提供：

- `analyze_bilibili_video`：B 站专用工具，保留旧文本与 provenance 形式。
- `analyze_video`：本地视频视觉分析。
- `inspect_video_window`：本地视频源区间的视觉检查。

旧 B 站工具保留默认严格要求 1080p30 的画质语义；通用工具默认使用实际可用源。已有 `STEPFUN_*`、`GEMINI_*`、`BILIBILI_*` 配置继续兼容。

认证按平台显式配置。仅为指定平台设置已授权的 Cookie 文件或浏览器来源，各 Adapter 不复用其他平台的凭据。小红书仅使用显式设置的 `XIAOHONGSHU_COOKIES_FILE` 或 `XIAOHONGSHU_COOKIES_FROM_BROWSER`。公开元数据、选定字幕或媒体，以及可选社区内容，可能发送到配置的模型 Provider。

## 开发

```bash
npm run dev
npm run typecheck
npm test
npm run build
```

离线测试不需要 Provider 凭据，也不访问真实视频平台。编译后的通用工具已实测 YouTube 字幕、YouTube 非零起点视觉区间，以及 B 站音频/ASR 回退。B 站结果为 `partial`，明确记录字幕访问限制和丢弃无效引用的告警。这些检查验证集成和引用结构，不代表模型准确率。具体结果与部署检查见[验证记录](./docs/validation.md)。

完成 build 后，生产部署可以保留 `dist` 并运行 `npm ci --omit=dev`。`npm start` 和 `npm run doctor` 均运行编译后的 JavaScript，无需 `tsx`；外部媒体依赖和 Provider 配置仍需通过 doctor。

## 许可证

[MIT](./LICENSE)，保留 BVR 来源与贡献历史。
