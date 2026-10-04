# 配置与存储

`@yiku/config` 提供 YAML、`.env`、深度合并和 `~/.yiku` 路径解析。Orchestrator 负责把通用对象
解析为严格的模型、Agent、Runtime、Skill、MCP、Memory、Flow 和 Eval 配置。

## 配置来源

YAML：

1. `~/.yiku/config.yaml`
2. `<workspace>/config.yaml`

项目字段覆盖用户字段；两个值都是对象时递归合并，数组和标量整体替换。

环境：

1. 启动进程环境
2. `<workspace>/.env`
3. `~/.yiku/.env`
4. 宿主显式传入的 `env`

后面的来源覆盖前面的同名变量。因此全局 `~/.yiku/.env` 覆盖项目 `<workspace>/.env`
的同名变量；这与 YAML 相反，用于让全局模型密钥不被项目占位值遮蔽。`loadEnvFile()`
只读取明确文件，不向父目录搜索。

## 模型与 Agent

```yaml
models:
  default: code
  items:
    code:
      name: your-openai-compatible-model
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.example.com/v1
      contextWindow: 128000
      agentName: Code Agent
      instructions: Be concise.

agents:
  default: code
  items:
    code:
      type: code
      model: code
      skills: [agents, code, skills, tasks]
      handoffs: []
      delegates: [reviewer]
    reviewer:
      type: code
      model: code
      skills: [code]
```

模型选择优先级：

1. 已持久化 Session Model 或调用方显式 `modelKey`，包括 CLI `/model` 切换后的值；
2. CLI `--agent` 对应的 Agent Model；
3. `AI_MODEL`；
4. `models.default`；
5. `AI_MODEL_NAME`。

`AI_MODEL_NAME` 可以覆盖 Provider Model Name，但 Model Key 仍用于配置选择。

密钥解析：

1. `AI_API_KEY_ENV`；
2. Model Item `apiKeyEnv`；
3. 存在 `AI_API_KEY` 时使用该变量；
4. 默认 `OPENAI_API_KEY`。

密钥只放在 `.env` 或进程环境，不写入 YAML。

## Runtime

```yaml
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
```

`compactToContextRatio` 必须小于 `compactAtContextRatio`。整数预算都有硬上限，未知字段拒绝。
自动与手动触发、Token/字符回退算法、History 替换和 Hook 顺序见
[Context Compact](../features/context-compaction.md)。

## Memory、Flow 与 Evals

```yaml
memory:
  enabled: true
  extraction: true
  failureMode: best-effort

flow:
  trace: false

evals:
  enabled: true
  mode: enforce
  maxConcurrentRuns: 8
  maxRepairAttempts: 1
  timeoutMs: 600000
  profiles: {}
```

`flow.trace` 只控制内部 Receipt 和 Sink Error 是否进入可见事件，不关闭 Atomic Flow。

## Skills 与 MCP

```yaml
skills:
  items:
    github:
      instructions: Use GitHub for source discovery.
      mcp: [github/search_*]

mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ["@modelcontextprotocol/server-github"]
      env: [GITHUB_TOKEN]
      tools: [search_*]
```

HTTP MCP：

```yaml
mcp:
  servers:
    remote:
      transport: streamable-http
      url: https://mcp.example.com/
      headers:
        Authorization: Bearer $MCP_TOKEN
      allowedEnvVars: [MCP_TOKEN]
      tools: ["*"]
```

HTTP URL 必须是 HTTPS，不能包含凭据、Query 或 Fragment。Skill 引用的 Server 必须存在，并与
Server Tool allowlist 和 Managed Policy 求交集。

## 主要环境变量

| 变量 | 用途 |
| --- | --- |
| `YIKU_AGENT` | 默认 Agent Key |
| `AI_MODEL` | Model Key |
| `AI_MODEL_NAME` | Provider Model Name |
| `AI_API_KEY_ENV` | API Key 变量名 |
| `AI_API_KEY` | 通用 API Key |
| `OPENAI_API_KEY` | 默认 API Key |
| `AI_BASE_URL` / `OPENAI_BASE_URL` | OpenAI 兼容 Endpoint |
| `AI_AGENT_NAME` | Agent 显示名称 |
| `AI_INSTRUCTIONS` | Agent Instructions |
| `AI_CONTEXT_WINDOW` | 正整数 Context Window |
| `YIKU_ATOMIC_STUDIO_URL` | Atomic Studio 回环端点 |
| `YIKU_WORKSPACE_DIR` | 部分宿主的显式 Workspace |

## Home 路径

```text
~/.yiku/
├── config.yaml
├── .env
├── permission/
│   └── global.json
├── memory/
│   └── memories.sqlite
├── skills/
│   └── <skill-name>/SKILL.md
├── workspaces/
│   └── <parent>_<workspace>[_<8-char-hash>]/
├── web.json
└── web.log
```

`web.json` 和 `web.log` 只用于 Web 服务注册与日志。

## Workspace Storage

`WorkspaceStorageLocator` 先解析 Workspace Real Path，再生成：

```text
<normalized-parent>_<normalized-workspace>
```

规则：

- Unicode NFKC；
- 小写；
- 非字母数字替换为 `_`；
- 去除首尾 `_`；
- 目录名已有其他 Real Path 时追加 `_` + 8 位 SHA-256 摘要；
- `workspace.json` 以 `0600` 记录所有者 `rootRealPath`；
- 目录以 `0700` 创建；
- Claim 使用临时目录和原子 Rename。

旧的 `yiku_` 前缀目录不会自动扫描、复用或迁移。

## Workspace 目录

```text
~/.yiku/workspaces/<storage-name>/
├── workspace.json
├── session/
├── logs/
│   ├── atomic-runs/
│   └── runs/
├── evals/
└── memory/
    └── memories.sqlite
```

- `session/`：Session State、Trace、消息和 Checkpoint 相关数据；
- `logs/atomic-runs/`：来源 Atomic Flow JSONL；
- `logs/runs/`：Agent Studio/Observatory Run；
- `evals/`：Plan、Attempt、Scorecard、Evidence 和 Baseline；
- `memory/`：项目长期 Memory。

运行数据不写入 `<workspace>/.yiku`。项目内 `.yiku/skills` 是可提交的 Skill 定义，不是 Runtime
Storage。

CLI Code Tool 的宿主边界把 `~/.yiku` 作为 Workspace 之外唯一的附加文件系统根。该授权精确
匹配目录边界，不覆盖 Home 的其他内容；符号链接逃逸仍被拒绝。目录内的删除、移动和其他高风险
操作继续经过 Permission Profile，不因存储位置而自动放行。

## Permission

`~/.yiku/permission/global.json` 保存：

- Active Profile；
- Filesystem 默认模式；
- Network 默认决策；
- Command/MCP/Policy Rule；
- Shell Sandbox 策略；
- Workspace Read-only/Read-write 授权；
- 授权 TTL。

默认授权 TTL 为 7 天。文件损坏、未知 Profile 或 Schema 无效时显式失败，不自动扩大权限。
CLI 的 Session Permission Grant 只存在于当前进程，不写入本文件；只有“长期允许此策略”更新
活动 Profile。

默认 Profile 的 `network.default` 为 `allow`，因此普通 `network.connect` 请求直接执行。用户
可以在自定义 Profile 中改为 `ask` 或 `deny`；Runtime 硬拒绝不能被该默认值覆盖。
旧版 v1 Permission 文件加载时会把内置 `default` Profile 迁移为该默认值并原子写回；自定义
命名 Profile 的网络决策保持不变。

Hook Trust 使用独立的 Hook Trust Store，由 CLI/宿主提供路径和生命周期；它不与 Workspace
Filesystem 授权混为一体。

本节只定义配置和存储位置。Permission Request 字段、规则优先级、Session/Persistent Grant、
Managed Policy、Shell 分类和 Sandbox 执行边界见
[Permission 与执行边界](../features/permissions.md)。

## 公开 API

```ts
import {
  ConfigStore,
  loadEnvFile,
  loadModelsConfig,
  mergeConfig,
  mergeEnv,
  WorkspaceStorageLocator,
  YikuPaths,
} from "@yiku/config";
```

- `ConfigStore`：带 Revision 的 YAML 配置更新；
- `loadModelsConfig()`：读取 YAML 为对象；
- `loadEnvFile()`：读取单个 `.env`；
- `mergeConfig()` / `mergeEnv()`：确定性合并；
- `WorkspaceStorageLocator`：安全声明 Storage 所有权；
- `YikuPaths`：生成所有 Home 和 Workspace 路径。

## 失败语义

- 配置文件不存在返回空对象；
- YAML 非对象返回空配置，严格字段在 Orchestrator 解析时拒绝；
- API Key 缺失阻止 Agent 创建；
- 未知 Skill、Delegate、MCP 或 Eval Profile 引用阻止启动；
- Workspace 必须是存在且可解析的绝对路径；
- Storage 所有权冲突使用摘要名，摘要再次冲突则失败；
- Permission 和 Store 写入使用私有权限与原子替换。

## 验证

```bash
corepack pnpm --filter @yiku/config test
corepack pnpm --filter @yiku/agent-orchestrator test
corepack pnpm --filter @yiku/cli test
```
