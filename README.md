# Yiku

Yiku 是一个基于 Ink + React + TypeScript 的命令行应用，背后由构建在 OpenAI Agents SDK 之上的
Agent 编排器驱动。

交互式 CLI 渲染只追加的静态时间线、GitHub 风格 Markdown 的助手回复、显式的工具调用与结果，
以及本地 JSONL 会话轨迹。Agent 执行委托给 `@yiku/agent-orchestrator`。

CLI 通过统一的 `SessionRuntime` 串联 Code Tools、Tasks、Skills、Hooks、MCP、Memories、
Subagent、Trace 和 Atomic Flow，并支持阶段自动续跑与跨进程恢复。

## 环境要求

- Node.js `>=22.13.0`
- pnpm

## 安装

```bash
corepack pnpm install
```

变量清单以 `.env.example` 为准：

```bash
AI_MODEL=code
AI_AGENT_NAME=Yiku Code Agent
AI_INSTRUCTIONS=You are a concise code assistant.
OPENAI_API_KEY=your-openai-api-key
```

API Key 放在 `~/.yiku/.env` 或 Workspace `.env`；不要把密钥写进 `config.yaml`。全局默认配置
位于 `~/.yiku/config.yaml`。下面这份基线包含全部运行时分区及其生效默认值：

```yaml
models:
  default: code
  items:
    code:
      name: your-openai-compatible-model
      apiKeyEnv: OPENAI_API_KEY
agents:
  default: code
  items:
    code:
      type: code
      name: Code Agent
      model: code
      skills: [agents, code, skills, tasks]
skills:
  items: {}
mcp:
  servers: {}
memory:
  enabled: true
  extraction: true
  failureMode: best-effort
flow:
  trace: false
runtime:
  autoContinue: true
  compactAtContextRatio: 0.7
  compactToContextRatio: 0.25
  maxNoProgressStages: 2
  maxParallelReaders: 3
  maxStageDurationMs: 1800000
  maxStagesPerEpoch: 20
  maxToolCallsPerStage: 200
  maxTurnsPerStage: 100
hooks: {}
```

Yiku 不内置 Provider 模型名和 API Key。请替换 `your-openai-compatible-model`；当 Provider 不使用
OpenAI 端点时，在对应 model 项下添加 `baseURL`。省略的 `skills`、`mcp` 和 `hooks` 分区为空。
当对应 Agent 配置省略时，会选用 Agent `code`、它的 type 以及它的四个默认 Skill。

### 配置优先级

两类配置的合并方向**刻意相反**，不是笔误：

| 配置类型 | 顺序（后者覆盖前者） |
| --- | --- |
| YAML | `~/.yiku/config.yaml` → `<workspace>/config.yaml`（项目覆盖全局） |
| 环境变量 | 进程环境 → `<workspace>/.env` → `~/.yiku/.env` → 宿主显式传入（**全局覆盖项目**） |

原因：大量仓库会提供带占位值的 `.env`。若项目 `.env` 覆盖全局，用户在 `~/.yiku/.env` 中的真实
密钥会被占位值静默遮蔽，表现为「明明配了 Key 却一直 401」。因此凭据类配置让全局优先，行为类
配置仍按「越具体越优先」处理。宿主显式传入的环境变量优先级最高，是需要为单个项目换 Key 时的
出口。完整契约见[配置与存储](docs/atoms/configuration-and-storage.md)。

项目根 `config.yaml` 作为本地覆盖层，还可以声明 Handoff、Delegate 和外部能力：

```yaml
agents:
  items:
    code:
      skills: [agents, code, skills, tasks, delegate, github]
      delegates: [reviewer]
    reviewer:
      type: code
      model: code
      skills: [code]
skills:
  items:
    github:
      mcp: [github/search_*]
mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ["@modelcontextprotocol/server-github"]
```

权限配置写入 `~/.yiku/permission/global.json`。Session、日志和项目 Memory 按
`~/.yiku/workspaces/<父目录>_<workspace>[_<8-char-hash>]/` 隔离，不写入项目目录。

## 使用

```bash
corepack pnpm build
corepack pnpm dev "Summarize this project"
corepack pnpm dev -- --agent triage "Review this repository"
corepack pnpm dev -- --continue
corepack pnpm dev -- --resume <session-id>
yiku web --port 3333
yiku web --stop
```

构建完成后，CLI 入口位于 `packages/cli/dist/index.js`，在该包被链接或安装后以 `yiku` 命令暴露。

交互式会话提供状态、校准后的上下文用量、记忆生命周期管理、用量、任务、压缩、初始化、Hooks
和退出等 Slash Command。记忆默认启用，可用 `/memory status|search|consolidate|forget` 管理。
已配置的 Skill 会以动态 Slash Command 暴露，一次最多串联六个。CLI 还提供递归模糊 `@` 文件补全、
高风险 Bash 审批、`Ctrl+J` 多行输入、连续两次 `Ctrl+C` 退出，以及手动退出时的上下文与用量汇总。

`yiku web --port 3333` 会打开 Atomic Flow 页面，并在同一终端继续交互式会话。若请求端口已被占用，
Yiku 会选择下一个可用端口。退出终端会话会关闭本次启动的 Web 服务；`yiku web --stop` 只清理已
注册的旧版后台观察器。

`/hooks` 管理与 Claude 兼容的生命周期 Hook、显式信任、启用与禁用状态、干运行，以及最近的已脱敏
操作记录。交互式提示复用同一个常驻 `AgentSession`。

## 脚本

```bash
corepack pnpm format
corepack pnpm lint
corepack pnpm build
corepack pnpm test
```

格式化与代码检查仅由 Biome 处理，不使用 ESLint 和 Prettier。

## 工作区结构

- `packages/config`：`~/.yiku` 与 Workspace 配置合并，以及运行路径解析。
- `packages/atomic-flow`：运行级原子、边、Sink、JSONL 与回放协议。
- `packages/flow-graph`：可复用的正交布线、障碍规避与路径诊断。
- `packages/evals`：确定性与基于 Provider 的运行评估。
- `packages/memories`：分域长期记忆、SQLite/FTS 持久化与混合检索。
- `packages/hooks`：与 Claude 兼容的 Hook 契约、执行器、决策、信任与安全限制。
- `packages/sandbox`：平台 Shell 隔离与可复用的进程启动描述。
- `packages/agent-orchestrator`：Agent Graph 解析、Handoff、执行、Hook 与会话轨迹。
- `packages/agent-studio`：协议无关的 Studio 服务端、React Shell 与编译期插件 SDK。
- `packages/agent-observatory`：Atomic Flow 观察插件、兼容 API 与默认 Web UI。
- `packages/trajectory`：轨迹数据、JSONL Trace 持久化与渲染器。
- `packages/agents/code`：CodeAgent 定义、Prompt、工具、权限策略与 `code` Skill。
- `packages/agents/research`：以证据驱动的 ResearchAgent、Research Skill、Ledger 与报告验证。
- `packages/cli`：Ink + React 终端 UI 与 `yiku` 可执行文件。
- `playground/agent-observatory`：Agent Observatory 页面、API、Slot 与主题扩展示例。
- `playground/research-agent`：Research Agent、Evidence 与报告验证示例。

## 文档

- [文档中心](docs/README.md)
- [系统总览](docs/architecture/system-overview.md)
- [Runtime 与编排](docs/architecture/runtime-and-orchestration.md)
- [CLI](docs/features/cli.md)
- [Code Agent](docs/features/code-agent.md)
- [Research Agent](docs/features/research-agent.md)
- [Agent-to-Agent 与 Subagents](docs/features/subagents.md)
- [Context Compact](docs/features/context-compaction.md)
- [Permission 与执行边界](docs/features/permissions.md)
- [Memories](docs/features/memories.md)
- [Evals](docs/features/evaluations.md)
- [Sandbox](docs/atoms/sandbox.md)
- [Atomic Flow](docs/atoms/atomic-flow.md)
- [Trajectory](docs/atoms/trajectory.md)
- [配置与存储](docs/atoms/configuration-and-storage.md)
- [架构分享页](artifacts/yiku-architecture-share.html)
- [面试题库](artifacts/yiku-interview-bank.html)

Package README 只提供包级快速入口。当前文档按架构层、功能层和原子层维护。