# Atom 目录

本文列出当前公开的内置 Atomic Flow 节点。Key 来自各 Package 导出的 `*_ATOMS` 和
`*_ATOM_DEFINITIONS`，是观测、Replay 和 Studio 布局使用的稳定标识。

## Runtime

来源：`@yiku/agent-orchestrator`

| Key | Kind | Label | 用途 |
| --- | --- | --- | --- |
| `run` | input | Run | 顶层运行 |
| `input.prompt` | input | Prompt Input | 用户输入 |
| `stage.start` | loop | Stage Start | 阶段开始 |
| `stage.finish` | loop | Stage Finish | 阶段终态 |
| `session.resume` | loop | Session Resume | Session 恢复 |
| `session.checkpoint` | store | Checkpoint | Workspace/Session 检查点 |
| `agent.select` | agent | Agent Select | Agent 选择 |
| `loop.turn` | loop | Loop Turn | 模型循环 |
| `model.invoke` | model | Model Invoke | 模型调用 |
| `tool.call` | tool | Tool Call | 工具执行 |
| `runtime.boundary` | tool | Runtime Boundary | Shell 隔离边界变化 |
| `observation` | loop | Observation | 工具结果进入循环 |
| `handoff` | handoff | Handoff | SDK Handoff |
| `user.question` | input | User Question | 运行中用户提问 |
| `action.gate` | action | Action Gate | 权限或动作门禁 |
| `task.snapshot` | store | Task Snapshot | Task 状态快照 |
| `subagent.lifecycle` | agent | Subagent | 子 Agent 生命周期 |
| `context.compact` | context | Context Compact | 上下文压缩 |
| `usage.record` | usage | Usage | Token 与资源用量 |
| `reply.final` | reply | Final Reply | 最终回复 |
| `observability.degraded` | trace | Observability Degraded | 观测降级 |

## Agent 与 Skill Capability

来源：`@yiku/agent-orchestrator`

| Key | Kind | 用途 |
| --- | --- | --- |
| `agent.profile` | agent | Profile 解析与快照 |
| `agent.spawn` | agent | 创建 Agent Instance |
| `agent.execute` | agent | Agent 执行 |
| `agent.result` | agent | Agent 结果 |
| `skill.resolve` | skill | Skill 发现与解析 |
| `skill.activate` | skill | Skill 激活 |
| `skill.execute` | skill | Skill Worker 执行 |

## Hooks

来源：`@yiku/agent-orchestrator`

| Key | Kind | 用途 |
| --- | --- | --- |
| `hook.dispatch` | hook | Hook Event 分发与决策 |
| `hook.execute` | hook | 单个 Handler 执行 |

`@yiku/hooks` 的审计操作还包含 `load` 和 `trust`，但当前 Runtime Atom 目录只公开 Dispatch 和
Execute。

## Memory

来源：`@yiku/memories`

| Key | Level | 用途 |
| --- | --- | --- |
| `memory.recall` | runtime | 完整召回流程 |
| `memory.search` | runtime | 搜索入口 |
| `memory.fts-search` | deep | FTS 候选 |
| `memory.query-embedding` | deep | Query Embedding |
| `memory.vector-search` | deep | 向量候选 |
| `memory.rerank` | deep | 融合与重排 |
| `memory.context-inject` | runtime | 注入 Agent Context |
| `memory.extract` | runtime | Session 记忆提取 |
| `memory.write` | runtime | 持久写入 |
| `memory.forget` | runtime | 忘记 |
| `memory.prune` | runtime | 过期清理 |
| `memory.consolidate` | runtime | 重复整理 |
| `memory.working` | runtime | Working Memory |
| `memory.working-capture` | runtime | Working Memory 捕获 |
| `memory.scenario` | runtime | 场景分类 |
| `memory.procedure` | runtime | 程序分类 |
| `memory.semantic` | runtime | 语义分类 |

## Evals

来源：`@yiku/evals`

| Key | Kind | 用途 |
| --- | --- | --- |
| `eval.trigger` | eval | 触发评估 |
| `eval.attempt` | eval | Attempt 生命周期 |
| `eval.flow-integrity` | eval | Flow 完整性 |
| `eval.final-output` | eval | 最终输出检查 |
| `eval.memory-safety` | eval | Memory 安全 |
| `eval.judge` | eval | 可选 LLM Judge |
| `eval.scorecard` | eval | Scorecard |
| `eval.repair` | eval | 自动修复 |
| `eval.gate` | release | 完成门禁 |
| `eval.decision` | release | Completion Decision |

`evaluatorAtom(key, label)` 可以生成 `eval.<key>` 动态节点。自定义 Evaluator 应使用稳定、
命名空间内唯一的 Key。

## Research

来源：`@yiku/agent-research`

| Key | Kind | 用途 |
| --- | --- | --- |
| `research.plan` | context | 研究计划 |
| `research.query` | input | 查询构造 |
| `research.search` | tool | Web Search |
| `research.evidence-record` | store | Evidence 写入 |
| `research.corroborate` | action | 交叉核验和反证 |
| `research.synthesize` | model | 综合分析 |
| `research.citation-validate` | eval | Citation 验证 |
| `research.report` | reply | 研究报告 |

## Flow 与 Trajectory

来源：`@yiku/atomic-flow`、`@yiku/trajectory`

| Key | Kind | 用途 |
| --- | --- | --- |
| `flow.sink-error` | trace | Sink 降级 |
| `trace.append` | trace | 持久 Trace Receipt |
| `trajectory.project` | trajectory | 兼容 Trajectory 投影 Receipt |

标准 Orchestrator 不需要发射 `trajectory.project` 才能生成轨迹；Observatory 和
`projectTrajectory()` 直接从 Atomic Flow Event 投影。

## 定义与实例

目录中的 Key 表示定义，不表示一次运行。事件关联应使用：

- `event.instance.id`：一次执行；
- `event.instance.parentId`：父执行；
- `event.instance.iteration`：循环次数；
- `event.edge.fromInstanceId`：精确来源；
- `event.sequence`：Run 内顺序。

不要用“最近一个同名 Atom”替代已知 Instance ID。

## 扩展规则

- Key 使用小写点号命名空间，例如 `checkout.payment-authorize`。
- Label 面向人类，不参与身份判断。
- Kind 选择最接近的现有语义。
- 只有高频内部步骤使用 `deep`。
- Payload 保持有界、可序列化和脱敏。
- 领域包定义 Atom，执行或 Observer 发射 Event。
- 新 Atom 同时增加协议测试和 Studio 降级展示测试。

事件协议见 [Atomic Flow](atomic-flow.md)。
