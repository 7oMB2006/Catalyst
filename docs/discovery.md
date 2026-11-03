# B 站问题驱动的候选发现

`discover_bilibili_videos` 围绕一个问题检索 B 站视频候选，返回搜索元数据、规范来源、查询命中与排序依据。宿主 Agent 选择少量候选，再调用现有视频研究工具读取字幕、音频和画面。

首版使用 B 站匿名 Web 搜索路径。这不是稳定的官方开放 API，可用性会受平台访问控制影响；本轮探测在成功返回候选后也遇到 HTTP 412，详见[真实验证记录](./validation.md)。工具保留已得到的候选和实际错误，不尝试绕过限制。

## 使用方式

```text
discover_bilibili_videos({
  question: "有哪些降低 Self-Attention 计算量的方法？",
  queries: ["高效注意力 Linformer", "稀疏注意力 原理"],
  max_candidates: 10,
  timeout_seconds: 30
})
```

| 参数 | 规则 |
| --- | --- |
| `question` | 3–2,000 字符的研究问题，保留在结果中作为任务背景。 |
| `queries` | 可选的 1–3 条检索词，每条 2–200 字符；由宿主根据问题生成。省略时，直接以问题作为唯一查询，问题需符合查询长度上限。较长问题应另传短查询。 |
| `max_candidates` | 返回候选上限，`1–20`，默认 `10`；不保证能够取得足额候选。 |
| `timeout_seconds` | 整次发现的共享期限，`1–120` 秒，默认 `30` 秒。 |

每个查询只请求第一页，每页最多 20 条。最多 3 个查询共享期限，每个 HTTP 响应最多 1 MiB。工具不自动翻页、不自动重试、不读取浏览器 Cookie，也不调用模型、ASR 或媒体下载器。实际检索词会发送给 B 站搜索；未传 `queries` 时即问题本身。不需要配置模型 Provider。

## 候选与已读证据

发现返回独立的 `DiscoveryResult`，不使用研究结果里的 Evidence 或 Findings。每条候选固定声明：

- `content_status: "not_read"`：只取得搜索元数据，没有读取视频内容。
- `media_access: "not_checked"`：尚未验证媒体可获取性。搜索成功不等于可下载、可转写或可分析。
- `duration_basis: "search_metadata"`：时长来自搜索结果，可能描述整个稿件，不能当作某个分 P 的已核实时长。

标题、简介与搜索摘要用于判断是否值得进一步研究。它们不能证明视频实际讲了什么，也不能成为字幕、语音或画面结论的引用。搜索返回内容仍是不可信的来源数据，不能当作执行指令。

## 身份、去重与排序

候选保留 `video_id`、`part_number`、`canonical_url`、标题、作者、搜索时长和摘要。没有明确分 P 的稿件级搜索结果使用 `part_number: null`，不会猜成第 1 P。来源中存在显式分 P 时，规范 URL 和去重身份均保留它。

同一身份被多个查询命中时合并为一个候选，`occurrences` 保留所有实际查询 ID 与原始排名。排名来自平台返回行的位置，丢弃无效行后也不重新编号。不同 BV 稿件不能仅因标题相似就视为相同内容；搬运或剪辑内容是否重复需要后续读取确认。

排序使用透明的 Reciprocal Rank Fusion（RRF）基线：

```text
score(candidate) = sum(1 / (60 + original_rank))
```

每个查询中的同一身份只贡献一次名次。`ranking` 返回方法、`k: 60`、实际分数、`basis: "search_metadata"` 和排序理由。分数表示在这些查询结果中的排序依据，不表示内容可信度、独立来源数量或经过模型核验的相关性。`k=60` 来自已有研究的常用基线，不宣称已对 B 站验证为最优值。

## 查询状态与结果完整性

| 字段或状态 | 含义 |
| --- | --- |
| 查询 `complete` | 本次搜索页取得有效候选。 |
| 查询 `empty` | 本次搜索页请求成功，返回行数为 0；不等同于平台请求失败。有行但全部无法解析为有效候选时为无效响应错误。 |
| 查询 `failed` | 该查询实际执行后失败，错误包含代码、说明和可重试性质。 |
| 查询 `not_run` | 受共享期限、取消或平台限制影响，尚未执行。 |
| 查询 `has_more` | 平台数据能判断时为布尔值，否则为 `null`；首版不据此继续翻页。 |
| `search_exhaustive: false` | 只研究有界搜索页，不能声称穷尽平台结果。 |
| `processing.candidates_omitted` | 已合并的候选中，因返回上限而未包含的数量；不表示平台全部剩余结果数。 |

顶层 `complete` 只表示本次请求范围内的查询完成，候选内容仍未读取。即使它为 `complete`，平台仍可能有后续页面，返回上限也可能省略候选。取得部分成功查询后，若其他查询失败、未运行或有无效行被丢弃，保留 `partial`；没有任何成功查询时返回 `unavailable`，并保留实际错误。所有查询成功但都为空时仍可为 `complete`。

`stop_reason` 区分正常完成、期限、取消、访问阻断、认证要求、限流和其他错误。遇到访问阻断、认证要求或限流，停止尚未执行的查询；普通单查询错误可继续处理剩余查询。返回“可重试”错误并不触发工具内自动重试。

结果记录每条查询的请求次数、取得页面、原始行数和丢弃行数，以及本次处理量、重复合并数与省略数。没有查询预算以外的后台执行或隐式额外检索。

## 与研究入口衔接

宿主根据候选及检索限制选择来源，将 `canonical_url` 交给 `analyze_video_url` 或 `analyze_long_video_url`。现有 Adapter 在研究前重新解析实际来源和所选分 P，核对 CID、分集标题和时长，再取得具体证据。

稿件级候选没有证明其中哪一 P 回答了问题；宿主需要明确所选分 P。不同候选的结论比较，应在实际读取后使用各自证据和覆盖范围。首版不自动研究候选、不生成跨来源最终答案，也不承担整体会话编排。

## 联网参考与取舍

本轮设计于 2026 年 11 月 3 日核查以下一手资料，再根据 Catalyst 现有研究工具与宿主边界作出工程取舍。这些资料提供可借鉴的设计，并不证明本项目的平台获取或排序效果。

| 一手参考 | 可借鉴的具体设计 | 本轮采用与边界 |
| --- | --- | --- |
| [Tavily 两步提取建议](https://help.tavily.com/articles/3363168593-extracting-web-content-using-tavily)及 [Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) | 先用检索摘要或分数筛选，再提取选中的正文；检索结果和原文内容分开。 | 发现候选与读取内容分开，保留实际查询和来源。首版不把全部结果交给模型总结，也不把摘要当正文证据。 |
| [Exa Contents API](https://exa.ai/docs/reference/get-contents) | 每个 URL 有自己的获取状态，而非只提供整个批次的成功标记。 | 每条查询保留状态和错误；候选的媒体访问状态独立，默认未检查。借鉴契约，不新增 Exa 服务依赖。 |
| [LangChain Open Deep Research 配置](https://github.com/langchain-ai/open_deep_research/blob/main/src/open_deep_research/configuration.py)、[执行边界](https://github.com/langchain-ai/open_deep_research/blob/main/src/open_deep_research/deep_researcher.py)与[结果去重](https://github.com/langchain-ai/open_deep_research/blob/main/src/open_deep_research/utils.py) | 代码层限制迭代与并发，去重后再处理内容。 | 用代码执行查询、候选和期限上限；合并重复身份时保留多次命中。该仓库已于 2026-08-21 归档，仅作为历史实现参考，不引入其内部多 Agent 循环。 |
| [RRF 原始论文，SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) | 根据各列表的名次融合排序，不要求不同列表的原始分数可比较。 | 使用可解释、无需模型的排序基线并公开计算依据；排序分数与内容可信度分开。 |
| [MCP 架构](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)和 [Tools 结果规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Host 协调上下文，Server 提供工具与结构化结果，结果可声明输出 Schema。 | 候选筛选和后续研究由宿主编排；工具暴露独立结果 Schema，同时提供 JSON 文本与结构化结果。 |

匿名 Web 搜索路径用于保留标题、作者和时长等搜索元数据；[yt-dlp 官方 Bilibili 搜索实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)也使用 `search/type`，但逐条 yield 链接，扁平搜索不会保留本入口需要的候选元数据。Catalyst 因此直接读取有界搜索页，而不触发逐候选的下载器解析。平台接口不是上述通用搜索服务提供的能力，必须单独验证可用性并保留访问限制。

## 验收要求

实际观察和测试计数单独记入[验证记录](./validation.md)。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 围绕实际问题搜索 | 返回可识别的候选和实际查询，不调用模型、ASR 或媒体下载。 |
| 同一稿件被多查询或多种链接命中 | 规范身份合并，保留查询 ID 与原排名；显式分 P 不串。 |
| 搜索结果缺少分 P、时长或访问信息 | 对应字段保持未知，不补成默认分 P、不宣称媒体可访问。 |
| 候选或查询预算用尽 | 上限生效，省略与未执行情况可检查；不隐式翻页。 |
| 空结果、坏行、接口错误或限制 | 查询状态与丢弃情况准确，成功候选保留；阻断或限流后停止后续请求。 |
| 取消、超时、超大响应 | 共享期限及响应字节上限生效，返回真实部分进度。 |
| 选择候选进入研究 | 由现有解析路径重新核对来源与分 P，之后才形成内容证据。 |

结构、预算与调用计数测试不代表真实检索相关性。匿名路径出现 HTTP 412 后停止探测；一次成功也不能证明日用访问稳定。
