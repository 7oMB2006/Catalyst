# Catalyst 首版架构

Catalyst 将平台获取与研究流程分开：平台 Adapter 提供统一素材，共用 ResearchEngine 决定如何使用字幕、音频和画面，MCP 层向宿主返回结构化结果与可读文本。当前覆盖 B 站、YouTube 和实验性小红书视频／图文笔记，保留 BVR 的旧工具以便渐进迁移。

长视频使用 `analyze_long_video_url`：`long-video.ts` 在共享期限和文件预算内编排概览与精读，`media-window.ts` 负责按源时间获取、验证及准备有界媒体。分段结果、概览覆盖、精读覆盖和未读区间随结果返回，失败段不能作为最终 Findings 的引用来源。B 站通用与兼容入口共用分 P 解析，CID、时长和下载 URL 对齐，并保留 `metadata.part_title`。具体约束见[长视频设计与验收](./long-video.md)。

长视频入口默认保存本地研究记录；`resume_long_video_research` 在重新核对来源和配置后复用已完成段，只处理失败或未完成段。每段结束时原子保存进度，服务重启后可恢复最近成功写入的检查点。记录只包含脱敏后的结果、字幕／转写和引用，不持久保存媒体；其他独立研究调用之间仍没有共享缓存。具体契约见[研究记录与断点续跑](./research-sessions.md)。

`follow_up_long_video_research` 用父记录已完成概览的字幕／ASR 研究新问题，并创建独立子记录。相关性、焦点、报告与答案重新生成；多模态追问先做语言概览，再获取新的音画精读窗口。全部可复用原始文本在首次子记录检查点保存，恢复不依赖父记录。具体契约见[同一视频的连续追问](./long-video-followup.md)。

`discover_bilibili_videos` 是研究前的独立候选发现入口。它在查询数、返回数、响应字节和共享期限内取得匿名搜索元数据，规范化来源身份并按实际查询排名融合排序；不取得媒体或生成内容证据。宿主规划检索词、选择候选，再调用现有研究入口。搜索命中不代表媒体可访问，稿件级结果也不等于已选定某个分 P。具体契约与联网设计参考见[B 站候选发现](./discovery.md)。

`compare_research_materials` 对宿主选定的 2–3 份已读视频／图文结果或保存会话进行纯文本对照。准备层保留证据的来源、时间／页码及原 ID，并隔离材料命名空间；代码生成连续摘录，模型选择编号并提出逐材料立场，程序回填引用、校验后重算关系和可读答案。源文本可按新问题重新分析，同问题有效视觉 Finding 只作为派生观察。工具不获取新媒体，来源独立性保持未知。具体设计与联网参考见[多来源证据对照](./comparison.md)。

`plan_research_followup` 是宿主执行前的确定性补读规划。它只读 1–3 份结果或保存记录，按明确证据通道和范围目标检查覆盖，返回现有研究／续跑／发现工具的有界参数。规划不调用模型或平台，也不执行或保存动作；宿主维护轮次与尝试历史，执行所选建议后带回新证据。对照的单来源或未涉及状态不能单独触发补读。具体契约与联网取舍见[有界补读规划](./research-followup-plan.md)。

## 调用路径

链接任务通过 `start_research_task` 接收 1–3 个已选择的来源和问题，`continue_research_task` 沿用任务 ID、材料和剩余额度，`get_research_task`、`list_research_tasks`、`delete_research_task` 管理本地记录。`link-research.ts` 以确定顺序直接调用已有引擎：视频使用可保存的长视频研究，小红书先识别图文／视频，多个已读来源进入现有文本对照。它不递归启动 MCP 服务，不搜索或自主扩展来源；宿主决定何时开始和继续。首次最多 3 步，续跑最多 4 步，每次调用内同一来源最多读一次，未读来源优先。详见[从链接开始研究与继续](./link-research.md)。

`research-task-cli.ts` 的 `start`／`continue` 通过编译后的 stdio 服务调用链接任务工具。旧 `create`／`run` 继续使用 `research-tasks.ts` 的 v1 固定补读计划与明确选择的动作 key，契约见[一轮补读与恢复](./research-tasks.md)。v2 链接任务与 v1 共用 `research-task-store.ts` 的通用原子快照、版本和进程锁；CLI 查看／列出／删除兼容两种记录，MCP 任务工具只管理 v2。调用意图及完整期限预留在外部工作前保存，结果校验后再记录；遗留在途调用转为未知并停止，不能自动重放。

链接任务按来源保留证据：长视频续跑复用成功窗口并重新综合；图文保留各次读取的页码、通道及报告，合并证据时隔离 ID，报告仍表达各自范围。来源后续解析失败时，旧可用材料继续保留并标明新失败。`comparison_current` 由当前来源结果与对照的输入历史决定，防止旧对照冒充已包含新证据的结论。单篇图文多次读取不会额外生成整篇综合，宿主基于保留证据回答。

```mermaid
flowchart TD
  Host[宿主 Agent] --> MCP[MCP analyze_video_url]
  Host --> Task[MCP start / continue_research_task]
  Task --> Long[可恢复长视频引擎]
  Task --> Note[图文研究引擎]
  Task --> Ledger[来源证据 调用意图和结果 累计额度]
  Task --> Compare
  Ledger --> Task
  Task --> Host
  Host --> Discovery[MCP discover_bilibili_videos]
  Discovery --> Search[B 站匿名搜索元数据]
  Search --> Candidates[DiscoveryResult 未读候选]
  Candidates --> Host
  MCP --> Engine[ResearchEngine]
  Engine --> Route[平台路由]
  Route --> Bili[BilibiliAdapter]
  Route --> YT[YouTubeAdapter]
  Route --> XHS[XiaohongshuAdapter]
  Bili --> Source[SourceContext 和 MediaAsset]
  YT --> Source
  XHS --> Source
  Source --> Engine
  Engine --> Transform[FFmpeg 媒体处理]
  Transform --> Provider[StepFun 或 Gemini]
  Provider --> Result[ResearchResult]
  Result --> MCP
  Host --> Compare[MCP compare_research_materials]
  Result --> Host
  Compare --> Prepared[已选材料和证据定位]
  Prepared --> TextProvider[一次文本 Provider 对照]
  TextProvider --> Validated[校验引用和立场 重算对照关系]
  Validated --> Host
  Host --> Plan[MCP plan_research_followup]
  Plan --> Coverage[只读材料 合并来源覆盖]
  Coverage --> Bounded[缺口 历史与预算检查]
  Bounded --> Actions[有类型 next_actions]
  Actions --> Host
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/link-research-contracts.ts` | 链接任务、来源、调用历史、累计预算和返回视图契约。 |
| `src/link-research-schema.ts` | 链接任务请求与保存记录校验，动作身份及嵌套长视频结果保留。 |
| `src/link-research.ts` | 从链接开始的有界读取、显式续跑、比较更新、预算和状态检查点。 |
| `src/link-research-materials.ts` | 保留来源材料，合并图文通道覆盖，隔离分次引用与报告范围。 |
| `src/link-research-receipts.ts` | 新访问链接与返回结果的来源、分 P、窗口／页码及引用校验。 |
| `src/link-research-tools.ts` | 五个链接任务 MCP 工具、参数适配与安全错误返回。 |
| `src/link-research-store.ts` | v2 链接记录及 v1／v2 通用读取适配，共用快照存储。 |
| `src/research-task-store.ts` | 两种任务共用的有界私有快照、版本比较、原子写入与进程锁。 |
| `src/research-tasks.ts` | v1 固定补读计划的明确动作选择、执行与恢复。 |
| `src/research-task-cli.ts` | stdio 参考宿主、链接任务及固定补读命令、本地管理命令。 |
| `src/contracts.ts` | 平台身份、能力、字幕、媒体、Evidence、Finding、失败和结果契约。 |
| `src/followup-plan-contracts.ts` | 补读材料、证据目标、缺口、动作、宿主历史与停止结果契约。 |
| `src/followup-plan-schema.ts` | 规划请求、独立结果及各现有工具建议参数的 Schema。 |
| `src/followup-plan-materials.ts` | 只读结果／保存记录校验，提取来源身份、证据通道和可用覆盖。 |
| `src/followup-plan.ts` | 合并同源覆盖，按目标计算缺口，应用预算／历史并产生有界建议。 |
| `src/comparison-contracts.ts` | 所选材料、命名空间证据、逐材料立场及独立对照结果契约。 |
| `src/comparison-schema.ts` | 对照请求、逐条模型输出和独立结果 Schema。 |
| `src/comparison-materials.ts` | 已读结果／只读会话准备、身份与覆盖检查、文本和派生观察的证据映射。 |
| `src/comparison.ts` | 一次文本对照、逐材料引用校验、关系重算和有效答案构造。 |
| `src/discovery-contracts.ts` | 候选、查询执行、排名依据、发现预算与独立结果契约。 |
| `src/discovery-schema.ts` | 发现工具的严格请求校验及独立结果 Schema。 |
| `src/discovery.ts` | 有界查询执行、状态保留、身份去重、RRF 排序与候选返回上限。 |
| `src/bilibili-search.ts` | 匿名搜索响应获取、字节限制、元数据规范化和访问错误识别。 |
| `src/result-schema.ts` | 与 MCP 工具发现一同暴露的结果 Schema，校验结构和字段；不承担结论语义验证。 |
| `src/process.ts` | 有期限和共享输出上限的子进程执行，以及取消时的进程组或进程树清理。 |
| `src/adapters/` | 校验来源 URL，取得元数据与语言素材，按平台管理可选评论和认证范围。 |
| `src/acquisition.ts` | 选择下载器运行环境、执行有界 yt-dlp 请求、取得媒体及实际质量、清理临时产物。 |
| `src/research.ts` | 三种研究模式、窗口校验、期限、证据组织、模型结果引用结构检查及部分失败结果。 |
| `src/long-video.ts` | 长视频概览、精读、分段检查点、恢复、追问执行及覆盖报告。 |
| `src/long-video-continuation.ts` | 续跑来源、原问题、窗口计划和已完成段引用的兼容性校验。 |
| `src/long-video-materials.ts` | 追问的父记录与计划校验，仅提取已完成概览的原始语言证据。 |
| `src/research-sessions.ts` | 记录执行、Provider 兼容标识、持久快照脱敏、续跑预算覆盖及独立追问记录。 |
| `src/research-session-store.ts` | 本地研究记录、原子写入、版本校验、会话锁和显式删除。 |
| `src/video-analysis.ts` | 静音、音轨与片段变换，StepFun 和 Gemini 调用，兼容旧调用签名。 |
| `src/media-quality.ts` | 显式质量目标与格式选择、实际质量评估。 |
| `src/index.ts` | MCP 输入输出、通用入口与兼容入口。 |
| `src/doctor.ts` | 本机依赖版本与配置存在性诊断，不进行平台或模型请求。 |

## 统一素材

候选发现返回 `DiscoveryResult`，与 `ResearchResult` 分开。候选中的标题、简介、作者和搜索时长用于来源筛选；`content_status` 固定为 `not_read`，`media_access` 固定为 `not_checked`，不进入 Evidence 或 Findings。查询命中记录保留原始排名，重复身份合并后仍可追溯至全部查询。RRF 分数是排序基线，不是事实可信度。候选送入研究工具后，才重新解析实际分 P、CID 和时长，并取得内容素材。

`SourceContext` 包含视频身份、字幕轨、评论和独立的能力状态。`VideoIdentity` 保留平台内容 ID、分 P 身份、原始 URL 与规范 URL。B 站的页面身份和时间长度应与所下载媒体一致；YouTube 的链接形式归一化到具体视频。

每种素材分别记录 `available`、`absent`、`unsupported`、`disabled`、`not_requested`、`error`、`auth_required`、`blocked` 或 `unknown`。例如没有字幕与字幕接口失败是不同状态。YouTube 评论采样在本预览版返回 `unsupported`，而非空评论样本。

小红书接收笔记 URL、官方短链或包含单条 URL 的分享文案。输入的 HTTP 短链先升级为 HTTPS，短链跳转逐步校验域名、协议和次数；提供的分享参数保留到下载器调用，对外结果 URL 只保留公开查询字段。源时长优先使用顶层元数据，否则只接受相互一致的流时长，不根据文件大小猜测。当前下载器不提供小红书字幕和评论，分别标记 `unsupported`，语言研究使用显式 ASR 回退。无格式结果为 `MEDIA_UNAVAILABLE`，不能据此认定为图文笔记。

`MediaAsset` 是请求内部的媒体引用，携带尺寸、帧率、下载字节和质量信息，并提供清理方法。媒体不会因为一次请求完成而获得永久可复查引用；对外 Evidence 保留原始来源和源窗口，必要时重新获取。

## 三种证据路径

小红书图文使用独立的 `note-contracts.ts`、`note-result-schema.ts` 和 `note-research.ts`，入口为 `analyze_xiaohongshu_note`。其外层结果声明 `content_type`，图文结果使用 `note` 与逐页证据，确认是视频时嵌入已有视频研究结果。原有 `analyze_video_url` 的输出契约保持不变；图文不伪装成零时长视频。

笔记获取读取受限大小的移动端页面，只用 JSON 安全解析服务端状态，验证实际笔记身份和类型。正文与有序图片分别获取，分享参数和 CDN 地址仅用于内部访问，输出引用规范笔记 URL。图文页面目前采用匿名获取，不读取浏览器会话；视频下载器的 Cookie 配置不自动成为图文页面登录态。

`text` 路径使用平台正文与逐页 OCR；`vision` 路径以最多四张图片为一批，生成对应页的视觉观察；`combined` 分别保存两者，再用这些证据回答。OCR 优先使用 macOS Swift/Vision，缺少运行时时回退到已配置 Provider 的图片转写。生成的 OCR 和视觉观察都标明来源与局限，不等同于独立核验的事实。指定页范围时只研究对应原始页码，不把整篇正文混入页内证据。

每次最多研究 50 张图片，超出时要求选页；每图最多 12 MiB、下载总量 128 MiB，内联模型图片请求另有 19 MB 上限。下载、OCR 与模型共用期限和取消信号，临时文件在结束后删除。OCR 另有进程内缓存，按图片内容哈希、语言和引擎/Provider 配置区分，最多 128 页、100 万字符、30 分钟；缓存不落盘，失败和空文本不入缓存。仍会重新获取来源图片以确认内容，答案不缓存。

获取层优先协商 JPEG、PNG、WebP、GIF；CDN 仍返回 AVIF 时，在返回图片资产前复用 FFmpeg 转为单帧 PNG。转码继承取消与期限，限制解码像素和单次内存分配，并验证 PNG 签名、实际尺寸、单图及累计产物字节；原始 AVIF 与失败产物均清理。输入下载量和转换后保留量分别受 128 MiB 总预算约束，`download_bytes` 始终表示网络下载字节。下游 OCR 与两种图片 Provider 共用同一份规范化图片。

- `language`：优先筛选请求窗口内的平台字幕 cue。无可用字幕时，抽取音频并转写，随后用语言证据回答。ASR 无分段对齐时只记录被提交的源区间。
- `vision`：对整个所选素材或指定片段移除音轨，将静音画面交给 Provider。
- `multimodal`：对原视频或所选片段同时使用声音与画面。

通用媒体研究单次最多处理 900 秒。超过该范围时要求显式缩小窗口并返回 `WINDOW_REQUIRED`。字幕路径使用独立的文本预算，过大的字幕请求同样需要缩小窗口。旧 BVR 工具保留原有长视觉视频粗扫与精扫流程。

## 证据与模型结论

程序创建的 Evidence 与模型解释分开保存。字幕时间来自实际 cue；静音或原媒体 Evidence 的时间只确定送去研究的源区间。Provider 没有给出确定性采样映射时，模型帧号和精确时刻不会成为已验证的抽帧证据。

模型被要求用已有证据 ID 引用结论。引擎会拒收无效 ID、没有主要语言或视觉证据的结论，以及格式不合要求的引用。有效引用仍只代表结构成立：所有模型 Finding 标记为 `verification: "unverified"`，语义正确性需要回到原始字幕或画面核验。

不要求结构化模型输出成功才能保留已有证据。非结构化返回会保留分析文本并给出告警，结果通常为 `partial`。媒体或 Provider 失败时，已获取的元数据和可用证据继续返回，错误记录阶段、代码和重试性质。

## 质量与预算

链接任务的累计声明期限默认 1,800 秒、最多 3,600 秒；来源步骤默认 240 秒，对照预留 `min(120, action_timeout_seconds)` 秒，每步整额预留且不退款。累计动作默认 12、最多 16，重启和继续均不重置。视频默认 600 秒概览段、最多 12 段，超限在预检时拒绝而非截断；每次视频调用的 128 MiB 获取文件额度不跨任务累计。v1／v2 共用最多 100 条、每条 8 MiB 的本地任务存储。关联视频 session 单独管理，删除任务不会删除 session。比较工具原有的每材料 80 项证据及 2 MiB 输入限制可使对照不可用，但不能使已保存的研究结果被丢弃。

补读规划只从结果里已有的通道、范围、身份、读取错误及显式搜索词推导动作，不从问题文字猜测需要整片或画面。默认继承各材料原模式，只检查原请求范围；宿主明确要求完整来源时才生成范围扩展。相同来源的互补覆盖先合并，旧问题视觉观察不能充作新问题覆盖。缺少可靠范围时保留选择条件；访问受阻不盲目重试，搜索阻断也不能推断媒体获取受阻。动作按目标工具 Schema 校验，新视频读取／图片页读取有单动作上限，保存记录续跑另按原窗口计划、期限与获取预算执行；轮次、来源、动作与已尝试 key 限制剩余建议。输入最多 2 MiB，本次规划默认 10 秒，模型及执行计数固定为零。历史由宿主传入，工具没有后台循环、持久账本或语义充分性裁决。

多来源对照使用独立的结果契约。其 `source_text` 引用已有字幕／ASR／正文／OCR，`derived_observation` 引用同问题下通过原引用校验、且只涉及同一定位的视觉 Finding；原 Finding 联合引用不同窗口或页码时整条排除，不复制成伪局部支持。两种证据都保留原有读取限制。代码预先生成最多 180 字符的连续摘录目录，模型选择编号，程序把原文和原证据定位回填到支持或反驳立场，再验证归属和精确子串。程序重算共同说法、分歧、单来源和证据不足；原最终 `analysis` 不进入模型提示。本轮只读已有会话，输入最多 2 MiB，准备提示最多 200,000 字符，最多一次文本 Provider 调用，不创建新的比较会话或自动发起资料补读。引用结构校验不能代替语义核验，跨来源的独立性不作推断。

通用入口在未指定 `source_quality` 时使用可用源并报告实际质量。视觉和多模态下载默认优先选择不超过 1080p 的格式，源回退以实际报告为准；媒体文件预算默认 256 MiB，可通过 `CATALYST_MAX_MEDIA_MB` 调整。显式质量请求沿用 BVR 的标准档、高档和自定义档，目标不满足时默认报错。旧 B 站工具保留默认严格 1080p30 的语义。

新流程有统一期限，向下载器、媒体处理与 Provider 传播取消信号，并在结束后清理临时目录。下载器仍可能需要获取完整源文件，再在本地裁剪，所以小窗口不等于仅下载相同长度的内容。阶段耗时和下载字节用于观察这一成本；没有返回的 token usage 和金额保持未知。

长视频记录保存自身已完成分段的字幕／转写、报告和引用，用于恢复同一个问题。复用前验证平台身份、分 P、时长、模式、原问题、语言、画质、计划及分析配置；失败段与不完整报告重新处理。续跑后用有效分段重新综合，不复用旧的最终答案。下载量和阶段耗时表示本次调用，已保存的覆盖不计作本次获取。

独立研究调用之间没有共享媒体／转写缓存，也不在原记录中更换问题。跨问题复用通过显式追问完成：校验父记录和当前来源后，复制已完成概览的原始语言证据，继承范围、概览划分、语言与画质，重新生成新问题的分析。纯语言追问无媒体或 ASR 调用；多模态追问的概览仍只有语言覆盖，新精读会获取音画并转写。缺失语言材料不自动补取，也不由父报告替代。

追问返回独立记录 ID，`follow_up` 指向父记录 ID、版本和已复制证据。父记录不被追问覆盖；子记录保存自己的原始文本、报告和覆盖，可独立恢复。首次追问没有跳过新问题报告，`session.reused_segments` 为零；之后恢复子记录时按原续跑规则计算。媒体缓存和 Provider 上下文复用仍属于后续工作。

## 运行环境和认证

`YTDLP_PATH` 与 `YTDLP_PYTHON` 用于显式选择下载器和解释器；可选的内置下载器缺失时允许外部安装。YouTube 获取命令显式启用当前 Node 作为 JS runtime。`FFMPEG_PATH` 覆盖内置 FFmpeg 路径。

B 站仅使用 `BILIBILI_COOKIES_*` 配置，YouTube 仅使用 `YOUTUBE_COOKIES_*`，小红书仅使用 `XIAOHONGSHU_COOKIES_*`。没有显式认证配置时不会自动选择浏览器登录态。B 站字幕 API 获取与 yt-dlp 的认证通道分别处理：配置给下载器的浏览器来源不会自动成为字幕 API 会话，因此可能出现媒体可获取而字幕为 `auth_required`，随后走显式 ASR 回退的情况。`.env` 或宿主环境向 Provider 注入凭据，doctor 只报告是否已配置。

B 站候选发现单独使用匿名 Web 搜索路径，不读取上述下载器 Cookie 配置或浏览器登录态。首版每查询最多一页，不自动重试；HTTP 响应受 1 MiB 上限约束。阻断、认证要求或限流会停止剩余查询，普通单查询错误与成功候选一起保留。匿名路径可受平台限制，不能由一次返回成功宣称长期稳定。

## 兼容边界

现有 `analyze_bilibili_video`、`analyze_video`、`inspect_video_window` 保留，原有 BVR 测试继续作为回归基线。通用研究结果、候选发现结果与旧文本呈现分别维护。B 站发现提供候选，跨平台搜索、长期调度和整体 Research Agent 编排仍由后续工作或宿主负责。
