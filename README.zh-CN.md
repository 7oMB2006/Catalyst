# Catalyst 催化剂

**简体中文** · [English](./README.md)

Catalyst 为现有 Agent 提供 B 站候选发现、视频与小红书图文研究 MCP。围绕具体问题，它发现可进一步研究的来源，读取可用正文、图片文字、字幕、音频和画面，返回来源、图片页码或源时间范围、获取状态和分析限制。

项目继承自 [Bilibili Video Research](https://github.com/7oMB2006/Bilibili-Video-Research)，保留原有 Git 历史与 BVR 工具。目前是从源码安装的早期预览版。

## 预览范围

| 来源 | 当前范围 |
| --- | --- |
| B 站 | 实验性候选发现、公开视频元数据、可用字幕或音频回退、媒体研究、可选采样评论。实际访问和画质取决于平台、内容及授权账户。 |
| YouTube | 公开视频元数据、可用人工或自动 JSON3 字幕及媒体研究；本预览版的评论采样返回 `unsupported`。 |
| 小红书（实验性） | 独立笔记入口读取正文、按页 OCR 和图片画面，识别为视频时复用视频研究。支持笔记链接、官方短链和完整分享文案。平台字幕与评论暂不支持，可用性取决于具体链接。 |
| 本地视频 | 保留视觉分析和静音片段检查工具。 |
| 抖音 | 获取能力调查候选，尚不列为预览版支持平台。 |

Catalyst 逐个读取来源，返回证据、覆盖范围和该来源的分析。宿主 Agent（harness）管理对话上下文、选择资料、比较多个来源并组织回答。长视频检查点保存单个来源的读取进度；有界 B 站搜索为宿主提供候选，跨平台搜索尚未实现。

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

## 读取选定链接

向宿主提供链接和问题。读取完整视频或选定 B 站分 P 时，使用分段入口，无需手动选择开头的一小段：

```text
analyze_long_video_url({
  url: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17",
  question: "这一节课介绍了哪些自注意力机制，各自解决什么问题？",
  mode: "language",
  language: "zh",
  max_detail_windows: 0,
  timeout_seconds: 1800
})
```

读取器规划所选来源范围内的全部概览窗口。B 站 `p` 只选择一个分 P，不读取整个合集。默认每段 600 秒、最多 12 个概览段；超出时在媒体获取前明确拒绝，不静默只读开头。问题需要图片、图表或可见动作时，选择 `vision` 或 `multimodal`。详见[长视频读取与限制](./docs/long-video.md)。

| 模式 | 使用的证据 |
| --- | --- |
| `language` | 优先采用可用平台字幕，否则使用音频／ASR；不读取视频画面。 |
| `vision` | 移除音轨后读取画面，画面中的可见文字仍可作为视觉证据。 |
| `multimodal` | 使用音画两种通道，长视频另以显式 ASR 提供语言证据。 |

概览媒体准备为最高 360p、1 fps，精读为最高 720p、5 fps。概览覆盖完整不等于每帧、每个公式都已读清。默认累计获取文件预算为 512 MiB、单份上传上限为 32 MiB、共享期限为 900 秒，可设置至 1,800 秒；宿主工具超时还需覆盖启动开销。预算或期限不足时保留部分报告。长视频按来源窗口获取媒体。

### 保存与恢复读取进度

长视频默认保存本地进度（`save_session: true`）。超时、取消或服务重启后，宿主可恢复同一问题尚未完成的读取：

```text
resume_long_video_research({
  session_id: "<原结果中的 session.id>",
  timeout_seconds: 1800,
  window_timeout_seconds: 300
})

get_research_session({ session_id: "<session.id>" })
list_research_sessions({})
delete_research_session({ session_id: "<session.id>" })
```

已完成的概览和精读保留报告、字幕／ASR 与引用。续跑只处理未完成段，然后重新生成该来源的回答和覆盖报告；成功段不重复下载、转写或分析。本次运行期限和获取文件预算重新计算，`session.reused_segments` 与 `session.processed_segments` 区分保留工作与本次处理。

查看和列出不请求来源或 Provider。记录位于 `~/.catalyst/sessions`，可用 `CATALYST_SESSION_DIR` 覆盖；保存脱敏结果和进度，不保存媒体、凭据或签名获取地址。`save_session: false` 可关闭保存。续跑固定原问题、来源／分 P、模式、语言、画质与窗口计划；可选的新 `url` 仍须指向同一来源。详见[记录存储与恢复](./docs/research-sessions.md)。

## 由宿主管理对话

例如用户给教程 A、B，问两种 Agent 设计有何区别。宿主分别读取链接，在自己的上下文中保留证据并比较；后来用户再给教程 C，宿主只读取 C，再结合已保留的 A、B 回答。Catalyst 无需为此另建多来源任务或“追加资料”操作。

用户接着问“按教程 A 整理最小实现步骤”时，宿主可以直接使用已有字幕、ASR、正文或 OCR。已保存视频的证据不在上下文中时，可通过 `get_research_session` 取回，无需重新读取来源；图文结果由宿主保留。缺少资料时，再选定时间窗口或图片页读取。旧生成答案和画面解释不等于原始文字；新问题需要检查画面时，应实际读取相关图片或片段。

默认服务暴露 11 个工具：

| 用途 | 工具 |
| --- | --- |
| 发现候选 | `discover_bilibili_videos` |
| 读取单个来源 | `analyze_long_video_url`、`analyze_video_url`、`analyze_xiaohongshu_note` |
| 恢复已保存的视频进度 | `resume_long_video_research`、`get_research_session`、`list_research_sessions`、`delete_research_session` |
| 原有 BVR 工具 | `analyze_bilibili_video`、`analyze_video`、`inspect_video_window` |

## 发现 B 站候选

```text
discover_bilibili_videos({
  question: "有哪些降低 Self-Attention 计算量的方法？",
  queries: ["高效注意力 Linformer", "稀疏注意力 原理"],
  max_candidates: 10,
  timeout_seconds: 30
})
```

工具返回搜索元数据、排序后的来源链接，以及每条候选实际命中的查询和原始名次。候选标记为 `content_status: "not_read"` 和 `media_access: "not_checked"`；搜索摘要和排序不能证明视频内容或媒体可获取性。没有显式分 P 的候选保留 `part_number: null`，搜索时长也不视为所选分 P 的已核实时长。

宿主可提供最多 3 条短查询；省略时直接以问题作为唯一查询，超过 200 字符的问题需要另传短查询。默认候选上限为 10，整次共享期限为 30 秒，每查询只请求第一页、最多 20 条。工具不调用模型、ASR 或媒体下载器，不自动重试、不读取浏览器 Cookie，无需模型凭据。选择候选后，将链接交给现有研究入口，重新核对来源和分 P 后再读取内容。

当前是实验性的 B 站匿名 Web 搜索路径，不是稳定官方开放 API。访问限制可能使结果为部分或不可用；阻断、认证要求和限流会停止后续查询。所有结果固定声明 `search_exhaustive: false`，因返回上限省略的候选数量单独报告。详见[发现设计、联网参考与验收要求](./docs/discovery.md)。

## 检查选定视频窗口

宿主需要核查具体画面时，可以选择原视频中的时间区间：

```text
analyze_video_url({
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  question: "哪些动物实际出现在画面中，能看到哪些特征？",
  mode: "vision",
  media_detail: "default",
  include_comments: false,
  start_seconds: 0,
  end_seconds: 15,
  timeout_seconds: 240
})
```

这是明确选定的窗口，不是粘贴链接后的默认读取范围。`start_seconds` 与 `end_seconds` 必须成对提供。通用工具对超过 900 秒的媒体要求选择至多 900 秒的窗口，否则返回 `WINDOW_REQUIRED`；纯字幕语言读取有独立的文本限制。本地文件可用 `inspect_video_window`，传入绝对 `video_path` 和源时间范围；`analyze_video` 提供本地视频视觉分析。

通用视频工具默认采用实际可用源并记录质量，视觉和多模态获取优先选择不超过 1080p 的格式。媒体文件预算默认为 256 MiB，可通过 `CATALYST_MAX_MEDIA_MB` 调整；获取流程可能先下载完整源文件，再裁剪所选区间。独立调用之间没有共享媒体或转写缓存。需要质量门槛时显式指定：

```text
source_quality: { profile: "high", on_unavailable: "error" }
```

沿用的档位包括 `standard`（1080p30）、`high`（1440p30），以及显式给出 resolution 和 fps 的 `custom`。默认拒绝不满足目标的源；`on_unavailable: "warn"` 允许明确记录的降级。提高目标档位不能补出原视频中不存在的细节。

小红书的 `url` 可粘贴笔记链接、官方 `xhslink.com`/`xhslink.cn` 短链，或包含单条链接的完整分享文案。请保留原始分享参数。HTTP 短链在访问前升级为 HTTPS，公开结果隐藏分享参数和签名媒体地址。合集、直播及无法确认时长的视频暂不支持；视频入口的空格式错误不代表已识别为图文，日常小红书读取优先使用下面的笔记入口。

## 研究小红书图文

```text
analyze_xiaohongshu_note({
  url: "https://xhslink.cn/o/Af8twEpdOVh",
  question: "作者介绍了怎样的 Agent 自动化架构？请引用图片页码。",
  mode: "text",
  language: "zh"
})
```

笔记入口先从页面实际数据确认内容类型。图文的 `text` 模式读取正文与所选图片的 OCR，适合长文章；`vision` 模式读取图片、截图和图表；`combined` 同时使用文字和画面观察。确认是视频时，三种模式分别交给已有的语言、视觉和多模态视频路径。图文没有伪造的时长或时间戳，证据引用原始顺序的第几张图；正文、OCR 和模型画面观察分别标记。

默认研究全部图片，单次最多 50 页；更长笔记必须成对提供 `start_page`/`end_page`（从 1 开始，包含末页），不会只看封面就宣称读完全篇。选择页范围时，证据不混入整篇正文。缺页、OCR 失败、看不清或无效引用会记录为部分结果，并保留已读取的证据。

默认图文 `vision`/`combined` 路径要求所配置的模型与渠道支持原生 JSON Schema 输出。每批按输入顺序为每张图返回一条观察，由程序绑定原始页码；输出无效时拒绝该批，保留已完成的其他批和 OCR。这只验证输出结构与页码映射，不代表画面观察正确。无需新增 MCP 参数；已测范围和 Provider 细节见[模型兼容记录](./docs/model-compatibility.md#2026-11-07--image-note-native-structured-output)。

macOS 优先通过可用的 Swift/Vision 执行本地 OCR；其他环境或缺少本地运行时时，图片会交给已配置的模型 Provider 转写。可设置 `CATALYST_OCR_ENGINE=provider` 或 `apple_vision` 显式选择。OCR 与画面理解都会出错，图中布局和箭头关系宜使用 `vision`/`combined` 核查。单张图片最多 12 MiB、下载总量最多 128 MiB；图片理解每批最多 4 张。收到 AVIF 时，先用 FFmpeg 转为单帧 PNG，再交给 OCR 或视觉分析；解码最多 4000 万像素，转换产物同样受图片字节预算限制。图文页面获取目前为匿名路径，`XIAOHONGSHU_COOKIES_*` 配置仅用于视频下载器。

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

## 旧研究流程兼容

任务管理、材料对照、补读规划和新问题追问保留在单独的兼容服务中，不出现在默认 `dist/index.js` 的工具列表。已有集成需要这些工具时，可显式改用以下 MCP 入口：

```bash
node /absolute/path/to/Catalyst/dist/legacy-research.js
```

兼容入口提供默认的 11 个来源工具和旧有 9 个流程工具。任务 CLI（`npm run task -- …`）自动连接该入口。已有任务和 session 记录无需迁移，也不会被删除；本地 `show`、`list`、`delete` 命令继续可用。新的宿主接入应由 harness 管理对话状态、来源选择、多来源比较和新问题回答。

旧契约详见[链接任务](./docs/link-research.md)、[任务追问](./docs/task-followup.md)、[材料对照](./docs/comparison.md)、[补读规划](./docs/research-followup-plan.md)、[选定轮次任务](./docs/research-tasks.md)及[长视频追问](./docs/long-video-followup.md)。

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
