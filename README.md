# Yiku

Yiku is an Ink + React + TypeScript command-line app backed by an agent
orchestrator built on the OpenAI Agents SDK.

The interactive CLI renders an append-only Static transcript, GitHub Flavored
Markdown assistant responses, explicit tool calls/results, and local JSONL
session traces. Agent execution is delegated to `@yiku/agent-orchestrator`.

CLI 通过统一 `SessionRuntime` 串联 Code Tools、Tasks、Skills、Hooks、MCP、Memories、
Subagent、Trace 和 Atomic Flow，并支持阶段自动续跑与跨进程恢复。

## Requirements

- Node.js `>=22.13.0`
- pnpm

## Setup

```bash
corepack pnpm install
```

The CLI merges `~/.yiku/.env` with `./.env`; Workspace values override global values. Use
`.env.example` as the variable reference:

```bash
AI_MODEL=code
AI_AGENT_NAME=Yiku Code Agent
AI_INSTRUCTIONS=You are a concise code assistant.
OPENAI_API_KEY=your-openai-api-key
```

API keys belong in `~/.yiku/.env` or the Workspace `.env`; do not put the secret value in
`config.yaml`. Global defaults live in `~/.yiku/config.yaml`. This baseline includes every
runtime section with its effective default:

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

Yiku does not ship a Provider model name or API key. Replace
`your-openai-compatible-model`; add `baseURL` to the model item when the Provider does not use the
OpenAI endpoint. Omitted `skills`, `mcp`, and `hooks` sections are empty. Agent `code`, its type,
and its four default Skills are selected when the corresponding Agent configuration is omitted.

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

## Usage

```bash
corepack pnpm build
corepack pnpm dev "Summarize this project"
corepack pnpm dev -- --agent triage "Review this repository"
corepack pnpm dev -- --continue
corepack pnpm dev -- --resume <session-id>
yiku web --port 3333
yiku web --stop
```

After building, the CLI binary is available from `packages/cli/dist/index.js` and
is exposed as `yiku` when the package is linked or installed.

Interactive sessions support session status, calibrated context usage, memory lifecycle management,
usage, tasks, compaction, setup, Hooks, and exit slash commands. Memory is enabled by default and
can be managed with `/memory status|search|consolidate|forget`. Configured Skills are exposed as
dynamic slash commands and can be chained up
to six at a time. The CLI also provides recursive fuzzy `@` file completion, high-risk Bash
approval, multiline input with `Ctrl+J`, double-`Ctrl+C` exit, and a final context/usage summary on
manual exit.

`yiku web --port 3333` opens the Atomic Flow page and continues as an interactive conversation in
the same terminal. If the requested port is occupied, Yiku selects the next available port. Exiting
the terminal conversation closes its Web server; `yiku web --stop` only cleans up a registered
legacy background observer.

`/hooks` manages Claude-compatible lifecycle Hooks, explicit trust, enable/disable state, dry runs,
and recent sanitized operations. Interactive prompts reuse one persistent `AgentSession`.

## Scripts

```bash
corepack pnpm format
corepack pnpm lint
corepack pnpm build
corepack pnpm test
```

Formatting and linting are handled by Biome only. ESLint and Prettier are not
used.

## Workspace Layout

- `packages/config`: `~/.yiku`/Workspace 配置合并和运行路径解析。
- `packages/atomic-flow`: shared run-scoped atom, edge, sink, JSONL, and replay protocol.
- `packages/flow-graph`: reusable orthogonal routing, obstacle avoidance, and route diagnostics.
- `packages/evals`: deterministic and provider-based run evaluations.
- `packages/memories`: scoped long-term memory, SQLite/FTS persistence, and hybrid retrieval.
- `packages/hooks`: Claude-compatible Hook contracts, executors, decisions, trust, and security.
- `packages/sandbox`: platform Shell isolation and reusable process launch specifications.
- `packages/agent-orchestrator`: agent graph resolution, handoffs, execution, hooks, and session traces.
- `packages/agent-studio`: protocol-neutral Studio server, React shell, and compile-time plugin SDK.
- `packages/agent-observatory`: Atomic Flow observer plugin, compatibility API, and default Web UI.
- `packages/trajectory`: trajectory data, JSONL trace persistence, and renderers.
- `packages/agents/code`: CodeAgent definition, prompt, tools, permission policy, and `code` Skill.
- `packages/agents/research`: evidence-led ResearchAgent, Research Skill, Ledger, and validation.
- `packages/cli`: Ink + React terminal UI and `yiku` binary.
- `playground/agent-observatory`: Agent Studio 页面、API、Slot 和主题扩展示例。
- `playground/research-agent`: Research Agent、Evidence 和报告验证示例。

## Documentation

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

Package README 只提供包级快速入口。当前文档按架构层、功能层和原子层维护。
