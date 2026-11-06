# 围绕已读来源继续追问

用户先给两个教程链接，问“这两种 Agent 方案有什么区别？”，随后再问“按第一种方案，整理最小实现步骤并标明依据”。宿主用已保存任务的 ID 调用 `follow_up_research_task`，无需重新传链接或搬运材料 JSON。

追问创建独立子任务，保留父任务的原问题、结果、预算和文件。子任务沿用相同的 1–3 个来源，并保存创建时的父 ID、revision 和原始文字快照。父任务后来继续、被删除，或关联 session 不再存在，都不会使这份文字快照失效。

## 开始一个新问题

```text
follow_up_research_task({
  task_id: "<已有研究的 task.id>",
  question: "按这些教程中的做法，整理最小实现步骤，并标明每一步的来源依据。",
  mode: "language"
})
```

`task_id` 可以指向普通链接任务或已有追问子任务。来源集合固定，接口不接受新 `urls`；选择其他来源应另建链接研究。父研究可以部分完成，子问题只使用其中已经确认保存的材料，保留原来的范围与不确定性。

默认 `language` 只对保存的字幕、ASR、正文和 OCR 生成新回答，不请求平台，不下载媒体，不再转写或 OCR，也不会自动补齐父研究的未读区间。父材料没有原始文字时，返回明确的材料不足，不把旧视觉解释改写成文字证据。

文字快照排除父任务的最终分析、Findings、视觉观察和分段报告。来源正文、OCR 与转写仍是未核验数据，模型必须围绕新问题重新分析。子任务保存后不需要再次读取父文件或检查父 session 的 Provider 兼容性。

## 回答、引用与继续

追问返回普通任务视图，并增加：

- `task.follow_up`：父任务 ID、所选 revision 和逐来源文字快照。
- `answer`：针对子问题生成的回答及逐条来源引用；可读内容在 `answer.analysis`。
- `answer_current`：保存的回答是否覆盖当前快照和最新读取结果。

回答支持 1–3 份材料，复用既有摘录选择与引用校验。模型选择程序生成的原文摘录编号，程序回填精确文字及原视频时间／图片页码，并核对材料归属。有效引用只说明出处结构可检查，不能证明模型解释正确或来源相互独立。

`comparison`／`comparison_current` 继续用于普通任务的材料对照；追问使用 `answer`／`answer_current`。新读取增加证据后，旧回答会过期；当前回答不可用时保留原材料和已有旧回答，并明确其时效。

```text
continue_research_task({ task_id: "<返回的子任务 task.id>" })
get_research_task({ task_id: "<子任务 task.id>" })
list_research_tasks({})
delete_research_task({ task_id: "<子任务 task.id>" })
```

宿主把“继续做刚才的问题”关联到子任务 ID。列表包含子问题及父 ID／revision。查看和列出不会研究来源；删除子任务不删除父任务或视频 session。已有回答且输入未变时，再次继续不重复调用模型。

## 新问题需要画面时

```text
follow_up_research_task({
  task_id: "<父任务 task.id>",
  question: "这些教程的架构图如何划分 Agent 和工具的职责？请引用实际检查的画面。",
  mode: "multimodal"
})
```

`vision` 为新问题实际检查画面，回答仅使用这次的新视觉证据；`multimodal` 将新视觉证据与保留的原始文字结合。新视频调用走 `vision` 路径，不重复 ASR；图文也只补做视觉读取。父任务的旧视觉 Findings 不作为子问题的新观察。

新旧证据分别隔离 ID，并保留原来源身份、分 P、时间区间或图片页码。视觉单次报告不等于两种通道的综合回答，最终回答另占一个步骤。`vision` 子任务仍保存原始文字快照，供之后的语言追问使用，但本次视觉回答不把文字当作画面。

每次创建最多执行 3 步；文字追问通常只有一个回答步骤。若三个来源都要重新检查画面，首次的三次读取可能用满步数，之后用子 ID 继续生成回答。继续每次默认最多 3 步，可用 `max_steps: 1–4` 调整，均受子任务剩余额度限制。

平台需要新访问参数时，可传 `source_urls: [{ source_id, url }]`，必须仍是已保存来源。原始访问参数只在本次调用内存中使用，不写入快照；本版仅在新的视觉读取需要访问时使用这些链接。

## 独立预算和停止边界

| 参数 | 默认与范围 |
| --- | --- |
| `mode` | `language`；也可选 `vision`、`multimodal`。 |
| `language` | 省略时沿用父任务的语言设置。 |
| `total_timeout_seconds` | 新子任务默认 1,800 秒，范围 15–3,600。 |
| `action_timeout_seconds` | 每个来源读取默认 240 秒，范围 15–600。 |
| `max_actions` | 默认 12，最多 16，包含回答步骤。 |
| `segment_seconds`、`max_segments` | 省略时沿用父任务；范围分别为 120–900、1–24。 |
| `max_detail_windows` | 语言默认 0，其他默认 2，范围 0–4。 |

回答每次预留 `min(120, action_timeout_seconds)` 秒；每个已派发步骤整额预留且不退款。子任务有独立额度，不消耗或重置父任务额度；继续同一个子任务也不会重置预算。这些额度不是实际耗时、费用或网络流量。

回答沿用材料上下文限制，例如每材料最多 80 项证据、输入最多 2 MiB。超限会返回已知的 `unavailable`，不会截断快照后声称读全，也不会丢弃已保存原文。部分来源或不足证据继续以 `partial`／`unavailable` 表达；`completed` 不代表父来源全部读完或答案已独立核验。

调用意图和预算先落盘，结果通过来源、范围、输入快照和引用校验后再保存。保存失败会停止后续工作；真正的在途未确认调用保持 `unknown`，不会自动重放。默认执行器的视频 session 前置检查及存储限额沿用[链接任务契约](./link-research.md)。

## CLI 与嵌入宿主

CLI 输入使用 camelCase，不传 `urls`：

```json
{
  "question": "按已有教程整理最小实现步骤，并标明依据。",
  "mode": "language",
  "totalTimeoutSeconds": 300,
  "actionTimeoutSeconds": 60,
  "maxActions": 4
}
```

```bash
npm run build
npm run task -- follow-up PARENT_TASK_UUID /absolute/path/follow-up.json
npm run task -- continue CHILD_TASK_UUID
npm run task -- show CHILD_TASK_UUID
```

新鲜访问链接使用可选 `sourceUrls: [{ sourceId, url }]`。CLI 经编译后的 stdio MCP 调用追问入口；子任务仍由现有 `show`、`list`、`delete` 管理。

TypeScript 可调用 `followUpLinkResearchTask(parentId, request, options)`。默认执行器在本进程处理内部 `answer_research_materials` 动作；它不是独立暴露的 MCP 工具。注入自定义 `ResearchTaskHost` 时，宿主应为该动作调用导出的 `answerResearchMaterials`，并处理其他读取动作；不能假定原有 MCP 客户端能直接调用这个内部动作名。

## 设计参考

保存父 revision 的独立快照，参考 [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 对可继续状态和持久资料的区分；本实现沿用现有文件存储，不新增框架。

[Claude citations](https://platform.claude.com/docs/en/build-with-claude/citations) 对原文定位的说明作为引用设计参考。这里沿用 Catalyst 的摘录编号选择与代码校验，未引入 Claude API；指向真实原文仍不等于结论得到语义验证。执行与恢复验收见[验证记录](./validation.md)。
