# 从链接开始并继续同一次研究

宿主可以把用户的“链接＋问题”交给 `start_research_task`，随后用返回的 `task.id` 继续研究。用户不需要先读取资料、搬运结构化结果，或说明上次读到的视频时间和图片页码。

例如，用户贴两个教程链接，问“这两种方法有什么区别？”。宿主开始任务、根据返回的证据回答；如果还有未完成范围，用户之后说“继续”，宿主调用 `continue_research_task`。任务保留原问题、来源、已读证据、调用历史和剩余额度。

项目继承时的 BVR 三个工具 `analyze_video`、`inspect_video_window`、`analyze_bilibili_video` 已能分析本地视频或链接，但没有持久研究任务。这里增加从初次读取到后续补读的衔接；原有独立研究、长视频 session、追问、规划与对照工具继续可用。

## MCP 使用

```text
start_research_task({
  urls: ["https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17"],
  question: "这一节课介绍了哪些自注意力机制，各自解决什么问题？",
  mode: "language",
  language: "zh"
})
```

`urls` 接受 1–3 条明确选择的 B 站、YouTube、小红书链接；小红书也接受包含单条受支持链接的完整分享文案。一个链接可以独立研究，无需凑齐两份材料。`mode` 默认为 `language`，也可选择 `vision` 或 `multimodal`；图文分别映射为正文／OCR、图片观察、两种通道结合。

```text
continue_research_task({
  task_id: "<start 返回的 task.id>",
  max_steps: 3
})

get_research_task({ task_id: "<task.id>" })
list_research_tasks({})
delete_research_task({ task_id: "<task.id>" })
```

| 工具 | 行为 |
| --- | --- |
| `start_research_task` | 保存链接、问题和固定预算，并执行最多 3 步初始研究。 |
| `continue_research_task` | 继续同一个任务；`max_steps` 范围 1–4，默认 3，不重置预算。 |
| `get_research_task` | 读取保存的任务、进度、材料及对照是否已更新，不发起研究。 |
| `list_research_tasks` | 列出本地链接任务的问题、来源、状态和预算，不请求平台或 Provider。 |
| `delete_research_task` | 删除一个未被执行进程占用的链接任务；关联视频 session 单独保留。 |

宿主负责把对话中的“继续”关联到正确的任务 UUID。问题与来源集合在任务内固定；改问题或选择其他来源应开始新任务。工具只处理已给出的来源，没有候选搜索、后台续跑或自主扩展来源。

## 读取顺序与结果

每步是一次来源读取、视频 session 续跑、图文补页或文本对照。一次调用内，每个来源最多读取一次；尚未开始的链接优先于已有来源的补读。长视频的一次读取可以处理多个概览／精读窗口，受该步期限和获取预算约束。三条链接的初始读取可用满首次的 3 步；如果它们都已读完，下一次继续只需完成对照。

视频进入可保存的长视频引擎，按完整所选视频范围规划概览，再按模式做精读；B 站 `p` 只选择一个分 P，不读取整个合集。默认概览分段为 600 秒、最多 12 段，并非默认只看前 15 秒。超过预检分段上限时明确返回错误，不静默截取开头；可在创建任务时调整 `segment_seconds` 或 `max_segments`。完成概览也不代表每帧或每个公式都已读清。已保存且完成的分段在续跑时保留，未完成分段继续处理。

小红书先识别图文或视频；确认的视频也进入同一长视频路径。图文证据保留原始页码和实际取得的文字／视觉通道，补读只选择缺少的页与通道。同页已有 OCR 不会被新视觉观察覆盖，反之亦然；各次结果的证据和 Finding ID 按读取次数隔离。

返回值包含：

- `task`：持久任务、逐步调用结果、状态与预算；`task.id` 用于下一次继续。
- `progress`：每个来源当前是否已读、是否能继续以及停止原因。
- `materials`：每个来源保留下来的证据材料，可用于宿主回答与独立研究工具。
- `comparison` 与 `comparison_current`：已保存对照，以及它是否覆盖当前最新的来源结果。

单视频的综合回答由原长视频引擎生成。单篇图文经过多次读取后，`materials` 合并精确证据并保留分别标注范围的每次报告；这些报告**不是重新生成的整篇综合答案**，宿主应根据保留的证据与页码回答。

取得 2–3 份材料后，工作流在步数及预算允许时调用现有 `compare_research_materials`。它用当前各来源保留的材料比较，不重新下载媒体。新读取使旧对照过期时，`comparison_current` 为 `false`；宿主不能把旧对照当作已包含新证据的结论。比较失败或因其每材料最多 80 项证据、输入最多 2 MiB 等限制不可用时，原研究结果仍然保存，这些比较输入上限不用于丢弃已完成研究结果。

后续读取如果未能重新解析来源，早先可用的材料与报告仍保留，并标明最新失败及旧报告范围；保留不等于已完成新读取。`completed` 表示任务计划覆盖和所需对照已记录，不证明问题已经充分回答、引用语义正确或来源相互独立。所有模型结论继续保持未核验状态。

## 预算与停止

| 参数 | 默认值 | 范围与含义 |
| --- | --- | --- |
| `total_timeout_seconds` | 1,800 秒 | 15–3,600 整数秒；整个任务的声明期限额度。 |
| `action_timeout_seconds` | 240 秒 | 15–600 整数秒；每次来源读取／续跑的期限。 |
| `max_actions` | 12 | 1–16；累计已发出的步骤上限，包含对照。 |
| `segment_seconds` | 600 秒 | 120–900；视频概览段长度。 |
| `max_segments` | 12 | 1–24；视频概览预检段数上限。 |
| `max_detail_windows` | 语言为 0，其他为 2 | 0–4；语言模式要求 0，其他模式使用相应精读计划。 |

对照每次预留 `min(120, action_timeout_seconds)` 秒。来源调用前按该步完整声明期限预留额度，**即使很快返回也不退款**。例如总额度 300 秒、单步 240 秒时，只能读取一次来源，剩余额度不足以再读一次；新进程继续也不改变这个结果。该额度不是实际耗时、费用或下载量，预算用尽时保留已有结果并返回 `budget_exhausted`。

视频每次读取／续跑的获取文件额度为 128 MiB，按调用计算，不跨任务累计，也不是硬性网络流量上限。宿主工具超时需覆盖本次可能执行步骤的期限总和，并为每步清理与启动留出余量。

调用意图、动作身份和期限预留先保存，之后才访问平台或模型；返回后校验来源、分 P、窗口／页码与引用，再保存结果。取消、失去确认、无效结果或进程在途中退出，会使该步成为 `unknown` 并进入 `needs_attention`，停止后续工作。它可能已经产生成本或保存视频 session，不能把丢失确认当作没有执行；此时继续不会自动重放，需先检查原结果／session。`get` 与 `list` 只读，不承担自动修复。

## 分享链接与本地记录

原始分享参数只在本次调用的内存中用于获取，不写入任务快照。平台需要更新后的访问链接时，可继续同一个来源：

```text
continue_research_task({
  task_id: "<task.id>",
  source_urls: [
    { source_id: "source:1", url: "<同一来源的新完整分享链接>" }
  ]
})
```

新链接必须对应保存的来源及已知分 P 身份，不能借此替换资料。`source_id` 来自 `task.sources`；访问参数仍不落盘。

链接任务使用 `schema_version: "2"`，与旧版固定一轮补读任务共用 `~/.catalyst/tasks`，可由 `CATALYST_TASK_DIR` 覆盖。两种任务共同限制为最多 100 条、每条 8 MiB。存储复用私有文件、原子替换、版本比较与跨进程锁；不保存媒体、模型凭据或 Cookie。视频 session 保存在单独目录；删除任务不会删除这些 session，可用原 session 工具管理。

## CLI

构建后把链接与问题保存为 JSON，CLI 采用 TypeScript API 的 camelCase 字段：

```json
{
  "urls": ["https://www.bilibili.com/video/BV1DTxXzUEvW/?p=17"],
  "question": "这一节课介绍了哪些自注意力机制？",
  "mode": "language",
  "language": "zh",
  "totalTimeoutSeconds": 1800,
  "actionTimeoutSeconds": 240,
  "maxActions": 12
}
```

```bash
npm run build
npm run task -- start /absolute/path/link-input.json
npm run task -- continue TASK_UUID
npm run task -- show TASK_UUID
npm run task -- list
npm run task -- delete TASK_UUID
```

可选的续跑 JSON 只接受本次步数和新访问链接：

```json
{
  "maxSteps": 1,
  "sourceUrls": [
    { "sourceId": "source:1", "url": "此处替换为同一来源的新完整分享链接" }
  ]
}
```

```bash
npm run task -- continue TASK_UUID /absolute/path/continue-input.json
```

`start` 和 `continue` 通过编译后的 stdio 服务调用新任务工具，返回任务视图。`show` 读取原始保存记录，`list`、`show`、`delete` 均可管理 v1 与 v2，且不启动服务或调用 Provider。MCP 的五个任务工具只管理 v2 链接任务；旧 v1 的 `create`、明确选择动作 key 的 `run` 保留原有[一轮补读契约](./research-tasks.md)。

## 设计参考

参考 [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 将可继续的任务状态与一般资料保存分开，并在步骤边界记录已完成工作。实现复用本项目已有文件存储和研究引擎，没有引入新框架。

[MCP tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 定义宿主可发现、按结构化参数调用的工具；这里用明确的开始／继续工具表达有界执行。对话关联、用户选择来源和下一次调用仍由宿主负责。测试与实际调用验收见[验证记录](./validation.md)。
