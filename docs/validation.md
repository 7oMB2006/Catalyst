# Catalyst 验证记录与验收案例

本记录区分 BVR 基线、调研验证和 Catalyst 实现验收。一次调用返回不能证明研究中的所有事实或时间引用正确；离线 fixture 也不能代替真实平台获取。

## BVR 继承基线

2026 年 11 月 2 日核对的上游提交为 `d2e0a982a3d63d417fdf8b84fc198b437183fd61`。重构前的 19 项离线测试和类型检查通过；测试使用 mock，不请求真实视频平台或模型。

## 初轮真实获取调查

调查分别使用 yt-dlp 2026.08.19 与隔离安装的 2026.10.26，对每个平台一至两个公开样本进行匿名探测。样本数不足以推断整个平台成功率。

| 来源 | 样本结果 |
| --- | --- |
| B 站 | 项目演示视频的匿名获取返回 HTTP 412；授权环境应另做回归。 |
| YouTube | 一个公开视频成功获取元数据、字幕和媒体；旧测试视频另一个 ID 已不可用。 |
| 抖音 | 样本返回 403 和 fresh cookies 提示。 |
| 小红书 | 样本没有返回视频格式，原因未确定。 |

这些是调研时的网络与样本记录，不是永久平台限制或产品支持保证。包含本机路径和调度信息的调研原始文件不随源码仓库分发。

## 研究流程调研样例

公开样本 [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw) 长 19 秒，实际为 320×240、15 fps。匿名媒体获取得到 629,172 字节，耗时 3.66 秒，英文人工字幕下载得到 6 条 cue。通过调研脚本手工连接既有 BVR `inspect_video_window`，对 0 至 15 秒去音轨后进行了一次 StepFun 分析，工具耗时 23.41 秒。

模型识别出大象，第 8 秒附近的源帧支持类别判断。但“两个动物下半身全程被遮挡”的描述与源帧可见腿部的情况不符；回答还生成了无采样依据的帧号和精确时刻。因此本例证明媒体、字幕、FFmpeg、MCP 和 Provider 能连接，同时暴露了逐条证据和时间精度问题。它不是 Catalyst 正式 Adapter 的验收，也不是模型准确率基准。

本例的 Provider usage 与费用未返回，保持未知。

## Catalyst 编译版真实调用

2026 年 11 月 2 日，通过编译后的 stdio MCP 服务调用统一工具 `analyze_video_url`。环境为 Node.js 26.12.0、yt-dlp 2026.10.26、EJS 0.8.0、外部 FFmpeg 9.0.1；分析模型使用 StepFun `step-3.7-flash`，B 站 ASR 使用 `stepaudio-2.5-asr`。

| 来源与模式 | 源区间 | 返回状态与耗时 | 证据与处理 |
| --- | --- | --- | --- |
| [YouTube Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw)，`language` | 0 至 15 秒 | `complete`，15.61 秒 | 元数据和 5 条字幕 cue，共 6 条 Evidence、1 条 Finding；未下载媒体。 |
| 同一 YouTube 视频，`vision` | 3 至 12 秒 | `complete`，31.35 秒 | 320×240、15 fps；下载 533,931 字节媒体，返回 2 条 Evidence、4 条 Findings。 |
| [BVR 演示视频](https://www.bilibili.com/video/BV1dPeP6REwM/)，`language` | 0 至 15 秒 | `partial`，25.57 秒 | 元数据和 ASR 共 2 条 Evidence、1 条保留 Finding；获取 1,782,375 字节纯音频后按窗口转写。 |

B 站字幕状态为 `auth_required`：字幕 API 没有复用下载器已有的授权浏览器登录态，而下载器可以取得音频。因此流程记录字幕访问限制，并明确使用 ASR 回退。模型另返回的一条无效引用被丢弃，结果保留有效证据与一条有效引用的 Finding，以 `partial` 表达真实降级。

三次调用中保留的 Findings 均为 `verification: "unverified"`，引用 ID 均指向实际存在的 Evidence。这里只核查了集成、状态与引用结构，没有把这些结果作为模型准确率或精确时间定位基准。三次结果的 Provider usage 均为 `null`，费用未知。

## 部署检查

生产依赖安装已通过：环境不提供 `python` 别名，也没有 `tsx`，`npm ci --omit=dev` 仍可完成；可选的 `yt-dlp-exec` 缺失时，编译后的核心可以导入并返回无效 URL 的结构化错误。运行时获取仍需提供可执行的外部 yt-dlp/解释器及 FFmpeg。生产依赖环境中的编译版 stdio 服务启动成功，并发现 `analyze_video_url`、`analyze_bilibili_video`、`analyze_video`、`inspect_video_window` 四个工具。

在显式注入已有本机依赖和 Provider 配置的环境中，doctor 的 Node、FFmpeg、Python、yt-dlp、EJS、Provider 六项全部为 `ok`，没有请求平台或模型。`npm run doctor` 执行 `node dist/doctor.js`，不依赖开发工具；Provider 项只验证配置存在，不能据此推断余额或 API 可用性。

## 本机离线与产物检查

首版最终本机检查中，**50 项离线测试全部通过，没有跳过项**；`npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。测试包含 4 项真实派生子进程检查，覆盖取消、超时和 `maxBuffer` 输出上限下的进程清理。

`analyze_video_url` 在 MCP 工具发现中声明 `outputSchema`。三份真实调用的结构化结果经回读后，使用同一结果 Schema 解析通过；Schema 验证结构和字段，不替代模型结论的事实核验。

`npm pack --dry-run` 检查列出 44 个文件，归档约 68 KB，没有包含本机调研原始数据。同次 `npm audit` 报告 0 项漏洞。这些是当前依赖锁与打包配置的检查结果；dry run 没有向 npm registry 发布软件包。

## 验收案例

下面六类案例覆盖完整的首版验收设计。上述真实调用覆盖其中的部分路径，其余受控夹具和语义核验仍需分别执行。

| 案例 | 输入与参考 | 核查内容 |
| --- | --- | --- |
| 有字幕的语言事实 | 有人工字幕的短片；人工记录两个关键事实与源 cue | 字幕存在时不下载媒体或调用 ASR，结论引用真实 cue，来源语言正确。 |
| 无字幕 ASR 回退 | 无平台字幕且讲话清晰的短片；人工转写 | 仅提交音频，区分字幕缺失与失败，不生成不存在的词级时间。 |
| 视觉独有信息 | 静音片段中的已知标签或动作，元数据和字幕没有答案 | 音轨确实移除，模型识别正确，语言路径不猜测画面。 |
| 非零窗口时间映射 | 已知第 27 秒发生事件，请求 25 至 35 秒 | 源窗口保留，偏移只应用一次，精度与依据明确。 |
| 失败与部分结果 | 参数错误、网络阻断、认证要求、质量不足与 Provider 失败 | 阶段、代码和状态可操作，保留已取得证据，不把失败写成内容事实。 |
| 重复研究与成本 | 同源不同问题，再改变画质或窗口 | 记录下载/转写/模型调用数、耗时与字节；当前无缓存时按真实基线报告。 |

结构化检查可以确定证据 ID 是否存在、时间范围是否有效；不能自动确定模型结论在语义上受证据支持。比较准确率或定位误差前，应先固定参考答案与容差。

## 本地检查

```bash
npm run typecheck
npm test
npm run build
npm run doctor
```

离线测试不得请求真实视频平台或模型。doctor 仅执行本机版本/import 探针和配置存在性检查。未配置 Provider 的干净环境会返回缺少凭据，EJS 无法确认时返回告警；这两种状态都应如实记录。

真实烟测应从公开短片、明确源区间和有限请求数开始。原始日志不应包含凭据、Cookie 内容或临时签名媒体地址。Provider usage 未返回时，记录未知值，不能从耗时推算收费。
