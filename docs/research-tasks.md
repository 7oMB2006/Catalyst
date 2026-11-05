# 宿主侧的一轮补读与任务恢复

这是现有 MCP 工具的参考宿主和可嵌入 TypeScript 执行器。它以已有 2–3 份材料创建固定补读计划，由宿主明确选择动作，顺序调用现有工具，保存结果和预算。MCP 服务本身仍只提供研究工具；没有新增自主研究 Agent。

## 使用

构建后，将规划请求保存为本地 JSON。这里采用 TypeScript API 的 camelCase 参数；内部适配器转换为 MCP 的 snake_case：

```json
{
  "plan": {
    "question": "这些材料怎样解释自注意力？",
    "materials": [
      { "kind": "video", "result": "此处替换为完整结构化视频结果对象" },
      { "kind": "note", "result": "此处替换为完整结构化图文结果对象" }
    ],
    "coverageTarget": "requested",
    "evidenceRequirement": "original",
    "maxActions": 3,
    "maxSources": 2,
    "actionTimeoutSeconds": 240
  },
  "totalTimeoutSeconds": 900
}
```

示例中的 `result` 占位字符串必须替换为实际结果对象。也可引用已有长视频 `{ "kind": "session", "session_id": "实际 UUID" }`，由连接的服务读取。发现候选不是已读材料。

```bash
npm run build
npm run task -- create /absolute/path/task-input.json
npm run task -- show TASK_UUID
npm run task -- run TASK_UUID SELECTED_ACTION_KEY_1 SELECTED_ACTION_KEY_2
# 在新进程中继续同一组已选动作
npm run task -- run TASK_UUID
npm run task -- list
npm run task -- delete TASK_UUID
```

`create` 只调用 `plan_research_followup`，不会执行补读。`run` 首次必须提供一个或多个计划中的 key；调用方不能传任意工具名或自行替换参数。首轮选择固定后，后续只能继续同一组动作。执行顺序沿用计划顺序。CLI 的 `create` 和 `run` 启动当前安装中的编译后 stdio MCP 服务，继承其显式 Provider／平台配置；其余命令只读写本地记录。CLI 输出 JSON，服务日志不混入输出。

嵌入其他宿主时，调用 `createResearchTask` 和 `runResearchTask`，传入实现 `ResearchTaskHost.callTool(name, arguments, signal)` 的已有 MCP 连接。回调返回工具的 `structuredContent`；参考 CLI 中的 `createMcpResearchTaskHost` 展示期限和取消传递。宿主继续负责问题、来源选择和后续综合。

## 记录、状态与恢复

默认目录是 `~/.catalyst/tasks`，可用 `CATALYST_TASK_DIR` 指定。任务与单视频 session 独立：任务保存脱敏输入、固定计划、所选 key、逐动作结果和预算；不保存媒体、Cookie、模型凭据或原始签名获取地址。每条记录最多 8 MiB，最多 100 条；通过 revision 比较、进程锁和临时文件原子替换保存。

| 动作状态 | 含义 |
| --- | --- |
| `pending` | 尚未发出调用，未消费执行预算。 |
| `running` | 调用意图、key 和预算已保存，随后才允许发送调用。 |
| `recorded` | 收到并校验结构化结果，已经保存；包含 `complete`、`partial` 或 `unavailable` 研究结果，恢复时均不会自动重复执行。 |
| `unknown` | 已保存调用意图，但没有可信的结果记录；调用可能已发生、产生费用或保存了单视频进度。停止后续动作，需宿主核查原工具或 session。 |

恢复时，已记录动作直接跳过。遗留的 `running` 转为 `unknown`，任务进入 `needs_attention`；取消、超时、连接失效或串源／错窗口等无效结果同样停在此状态。第一版不提供未知动作的自动重试或自动对账。记录中的动作 key 是本地历史身份，平台和模型 Provider 不一定支持它作为幂等键，不能据此承诺外部调用只发生一次。

结果保存失败会立即停止执行，不能继续消耗后续预算。若调用已经返回、但结果保存失败，磁盘仍保留 `running`；恢复后按未知结果处理，而不是假定调用没有发生。读取采用原子快照，删除遵守执行锁，不会在另一个进程正在运行任务时删除记录。

任务的 `completed` 表示所选调用均返回并保存了 `complete` 结果；`partial` 表示保存的研究结果存在部分失败或不可用。这些状态不证明问题已充分回答、引用语义正确或来源独立。

## 预算与下一轮

计划继续沿用最多 3 个默认动作、2 个默认来源及片段／页数上限。执行前，任务再检查持久预算：`max_actions` 沿用计划的 `maxActions`；`totalTimeoutSeconds` 默认 900，范围 15–1,800 整数秒。

每次调用前，将该动作声明的 `timeout_seconds` **整额预留，且不退款**。例如总预算 300 秒、单动作 240 秒时，只能发出一次调用，即使实际调用很快返回。`reserved_timeout_seconds` 是保守的执行期限额度，不是实际耗时、费用或总下载量。若额度不足，保留待执行动作并返回 `budget_exhausted`；重启不会重置额度。

任务只执行这份固定计划的一轮，没有自动规划下一轮、选择新候选、改变问题或执行比较。原材料保留在 `request.materials`，新增结构化结果在 `actions[].result`。宿主可将已有材料与新结果中明确选定的 2–3 份交给现有规划／对照工具，按工具预算更新研究；`discover_bilibili_videos` 的结果始终只是候选。新任务是显式的新预算，不是旧任务剩余额度。

## 联网参考与取舍

2026 年 11 月 5 日核查以下一手设计，没有引入新框架依赖：

| 参考 | 采用与边界 |
| --- | --- |
| [LangGraph Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) | 逐步骤保存完成结果，恢复时跳过已落盘成功工作；单轮记录与宿主对话分开。 |
| [LangGraph Fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance#treat-a-missing-acknowledgement-as-unknown) | 在副作用前保存意图；丢失确认属于未知，不是失败的证明。未知动作停止，不根据本地 key 假定 Provider 已做幂等处理。 |
| [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) | 参考宿主通过客户端连接现有工具服务，明确区分宿主的 JSON 输出与服务协议流。 |

离线、进程重启及编译后调用验收记录见[验证记录](./validation.md)。
