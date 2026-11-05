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

Discovery 从有界的 B 站候选搜索起步，确定性补读规划可按明确的证据与范围目标建议下一步读取或搜索。查询规划、候选选择、动作执行和整体对话由宿主 Agent 负责；跨平台搜索、自动研究循环和长期任务调度属于后续工作。

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

## 对照已读材料

宿主选定 2–3 份已读结果后，可以比较其中的共同说法、分歧及证据缺口。视频、小红书图文和已保存长视频记录可以混合使用：

```text
compare_research_materials({
  question: "这些材料对高效注意力的适用条件有哪些共同说法和分歧？",
  materials: [
    { kind: "video", result: <已有视频研究的完整结果> },
    { kind: "xiaohongshu", result: <已有小红书研究的完整结果> }
  ],
  language: "zh",
  max_comparisons: 6,
  timeout_seconds: 120
})
```

每条对照保留材料身份、原证据 ID 和视频时间／图片页码。程序生成连续原文摘录，模型选择摘录编号，再由程序回填引用，避免模型重写或拼接引文；引用仍须与原证据逐字匹配。未涉及和证据不足单独表示；重复来源不能增加独立佐证数量，结果固定声明来源独立性尚未建立。

对照只读已有结果，最多调用一次文本 Provider，不重新获取媒体。原始字幕、ASR、正文和 OCR 可按新问题重新分析；旧视觉观察仅在原问题与本轮问题相同时复用，旧最终答案不进入提示。输入限 2 MiB，模型提示限 200,000 字符，超限明确报错。引用通过只证明结构有效，所有对照仍为 `unverified`。输入类型、会话引用与联网设计取舍详见[多来源证据对照](./docs/comparison.md)。

## 规划有界补读

宿主可检查 1–3 份已有结果或保存记录的读取缺口，取得现有工具的有类型调用建议：

```text
plan_research_followup({
  question: "这节课怎样解释自注意力的计算过程？",
  materials: [
    { kind: "video", result: <已有视频研究的完整结果> }
  ],
  evidence_requirement: "original",
  coverage_target: "requested",
  max_actions: 3,
  max_rounds: 2,
  round: 1,
  attempted_action_keys: []
})
```

规划返回缺口、动作 key、源时间窗口或原始图片页码，以及通过校验的工具参数。本次不调用模型、不访问平台、不取得媒体，也不执行或保存动作。宿主执行选中的 `next_actions`，保留新证据，再携带已尝试 key 和更新后的轮次重新规划。默认每轮最多 3 个动作、涉及 2 个来源，新视频窗口不超过 180 秒，图文单次不超过 4 页；保存记录续跑可能在期限和获取预算内处理多个原计划窗口。

`original` 继承各材料原证据模式；`requested` 只检查原请求范围，明确设置 `coverage_target: "source"` 才扩展到已知完整视频或整篇笔记。换问题后旧视觉观察不算本轮视觉覆盖，原始文字仍可复用；重复材料的覆盖先合并。对照中的 `single_source` 或 `not_addressed` 不会自动触发补读，额外 B 站发现必须由宿主提供 `search_queries`。结构化来源访问限制和已尝试动作 key 会停止重复建议；模型鉴权错误不能证明来源被封锁。详见[补读规划设计、预算与联网参考](./docs/research-followup-plan.md)。

## 执行一轮选定补读

参考宿主保存固定补读计划，只通过现有 MCP 服务执行宿主明确选择的动作 key：

```bash
npm run build
npm run task -- create /absolute/path/task-input.json
npm run task -- run TASK_UUID SELECTED_ACTION_KEY
npm run task -- run TASK_UUID
```

输入包含 `plan`（TypeScript 规划请求，使用 camelCase 参数及 2–3 份已有材料），可选 `totalTimeoutSeconds`。首次执行固定所选 key，后续继续同一组动作并跳过已记录结果。调用前先保存意图和期限额度；中断或丢失确认的调用转为 `unknown`，交宿主核查，不会自动重放。研究结果的 `partial` 和 `unavailable` 状态继续保留。

任务保存在 `~/.catalyst/tasks` 或 `CATALYST_TASK_DIR`，与视频 session 分开。默认执行额度为 900 秒，每个动作按完整声明期限预留，不退款；这不是费用或下载预算。使用 `show`、`list` 和 `delete` 管理记录。其他宿主也可用自己的 MCP 连接嵌入执行器；来源选择、后续规划与对照继续由宿主负责。详见[任务输入、恢复边界与联网设计](./docs/research-tasks.md)。

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

长课程、访谈和讲座可使用 `analyze_long_video_url`。它完整规划所选范围的概览窗口，再精读相关片段，分别返回概览、精读和未完成范围：

```text
analyze_long_video_url({
  url: "https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17",
  question: "这一节课介绍了哪些自注意力机制，各自解决什么问题？",
  mode: "multimodal",
  language: "zh",
  segment_seconds: 600,
  max_segments: 12,
  max_detail_windows: 2,
  timeout_seconds: 1800
})
```

概览采用最高 360p、1 fps 的有界媒体；精读采用最高 720p、5 fps。完整概览不等于每帧或每个公式均已读清。默认累计获取文件预算为 512 MiB，单份准备后的媒体最多 32 MiB；默认期限 900 秒，可调至 1,800 秒，宿主超时应更长。预算或期限不足会保留部分结果。媒体按区间获取，详见[长视频设计与验收](./docs/long-video.md)。

### 保存与续跑长视频研究

长视频研究默认在本地保存进度（`save_session: true`），返回的 `session.id` 标识这份记录。超时、取消或服务重启后，可以继续原问题：

```text
resume_long_video_research({
  session_id: "<原结果中的 session.id>",
  timeout_seconds: 1800,
  window_timeout_seconds: 300
})
```

续跑保留已完成概览和精读的报告、字幕／转写及引用，只处理未完成段，再更新综合回答和覆盖范围。已完成段不重复下载、转写或分析。每次调用重新计算期限和获取文件预算；`session.reused_segments` 与 `session.processed_segments` 分别记录复用段数和本次处理段数。

`list_research_sessions` 列出记录，`get_research_session({ session_id })` 读取结果，`delete_research_session({ session_id })` 删除记录。默认目录为 `~/.catalyst/sessions`，可用 `CATALYST_SESSION_DIR` 指定其他目录。只保存脱敏后的结果和进度，不保存媒体文件、凭据或签名获取地址。首次调用可设置 `save_session: false`，不创建持久记录。

续跑固定原问题、来源与分 P、模式、语言、画质和窗口计划，只允许调整运行期限与获取文件预算。访问需要时可用可选 `url` 补传原始分享链接；解析后的来源必须一致，访问参数不落盘。任务不会在返回后自动后台续跑。详见[研究记录与断点续跑](./docs/research-sessions.md)。

### 对同一视频继续追问

以已保存的记录为起点，使用已完成概览段的字幕／转写提出新问题：

```text
follow_up_long_video_research({
  session_id: "<原结果中的 session.id>",
  question: "课程中介绍的两种注意力机制有什么区别？",
  mode: "language"
})
```

追问创建独立记录，保留父研究。它复用原始语言文本，重新判断相关性、生成报告并回答新问题。语言追问不下载媒体、不调用 ASR，仍需调用文本模型；没有可用文本的窗口明确保留为缺失。

公式或图表问题可用 `mode: "multimodal"`，先从语言分析选择新的精读窗口，再检查实际音画。概览仍是语言覆盖，精读会产生新的获取、ASR 和媒体分析调用。语言模式的 `max_detail_windows` 必须为 `0`，默认 `0`；多模态为 `1–4`，默认 `2`。来源范围、概览划分、语言和画质继承父记录，配置与来源身份须兼容。

追问返回新的 `session.id`，可独立读取、续跑和删除。`follow_up` 记录父版本与复制的语言证据；首次追问所有问题相关报告重做，因此 `session.reused_segments` 为 `0`。详见[连续追问设计与验收](./docs/long-video-followup.md)。

通用视频工具默认采用实际可用源，并记录真实质量。视觉和多模态获取优先选择不超过 1080p 的格式；发生源格式回退时，应查看实际返回的尺寸。媒体文件预算默认为 256 MiB，可通过 `CATALYST_MAX_MEDIA_MB` 调整。通用获取流程可能先下载完整源文件，再裁剪所选区间。独立研究调用之间没有共享媒体或转写缓存；已保存的长视频记录支持上述显式续跑与追问复用。需要质量门槛时显式指定，例如：

```text
source_quality: { profile: "high", on_unavailable: "error" }
```

沿用的档位包括 `standard`（1080p30）、`high`（1440p30），以及显式给出 resolution 和 fps 的 `custom`。默认拒绝不满足目标的源；`on_unavailable: "warn"` 允许明确记录的降级。提高目标档位不能补出原视频中不存在的细节。

小红书的 `url` 可直接粘贴笔记链接、官方 `xhslink.com`/`xhslink.cn` 短链，或包含单条链接的完整分享文案。请保留原始分享参数。HTTP 短链在访问前升级为 HTTPS，公开结果隐藏分享参数和签名媒体地址。合集、直播及无法确认时长的视频暂不支持。视频入口的空格式错误不代表已识别为图文；日常小红书研究优先使用下面的笔记入口。

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
