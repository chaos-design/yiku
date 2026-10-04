# CLI

`@yiku/cli` 是 Yiku 的默认终端宿主。它负责参数、Workspace 授权、Prompt 输入、补全、审批、
Slash Command、时间线和结构化输出；Agent 执行由 `@yiku/agent-orchestrator` 完成。

## 启动

仓库开发：

```bash
corepack pnpm build
corepack pnpm dev "审查当前仓库"
```

安装或 Link 后：

```bash
yiku
yiku --agent reviewer "审查认证边界"
yiku --continue
yiku --resume <session-id>
yiku web --port 3333
```

## 参数

| 参数 | 含义 |
| --- | --- |
| `--agent <key>` | 选择 `config.yaml` 中的 Agent |
| `--answers <file>` | 非交互答案文件，按稳定 `questionKey` 匹配 |
| `--init` | 在 Prompt 前执行项目初始化 |
| `--init-only` | 只执行初始化并退出 |
| `--maintenance` | 在 Prompt 前执行维护流程 |
| `--continue` | 恢复当前 Workspace 最新未完成 Session |
| `--resume <id>` | 恢复指定 Session |
| `--output <format>` | 输出 `text`、`json` 或 `ndjson` |
| `--policy <file>` | 非交互 Managed Policy，预授权精确 Capability |
| `web --port <port>` | 启动本地 Observatory 和交互会话 |
| `web --stop` | 清理已注册的旧后台观察器 |

`--output-format` 是 `--output` 的兼容别名。`--resume` 与 `--continue` 互斥。`yiku web`
默认端口为 `4317`。
未知 Option 和缺少值的 `--agent` 会直接失败；Prompt 本身需要以 `-` 开头时使用 `--` 终止
Option 解析：

```bash
yiku -- "--literal prompt"
```

## 交互与非交互

### 交互模式

终端支持 Raw Mode 时启动 Ink UI。首次进入 Workspace 会要求授权：

- 本次读写；
- 持久读写；
- 拒绝。

已有有效授权时不重复询问普通读写；风险命令仍按 Permission Profile 审批。

### 非交互模式

无 TTY 时直接运行 Prompt 使用文本输出，也可以显式选择机器协议。Workspace 必须已通过交互
模式授权：

```bash
yiku "检查项目状态"
yiku --output json --answers ~/.yiku/automation/answers.json "执行预配置任务"
yiku --output ndjson --policy ~/.yiku/policy/ci.json "运行 CI 检查"
yiku --output ndjson --continue
```

非交互模式不会弹出审批 UI，并统一 fail-closed：

- Workspace Trust 只决定 `read-only` 或 `read-write`，不批准具体副作用；
- 不提供通用 `--yes`；
- 缺少稳定 `questionKey` 的问题暂停，不再自动选择第一个选项；
- `preference` 只有代码侧可信 Manifest 和问题请求同时允许，且推荐 `optionId` 一致时才可自动
  选择；模型请求本身不能建立可信 Manifest；
- `required-input` 只有问题允许预配置且答案文件提供稳定 `optionId` 时才可继续；
- `permission` 和 `secret` 永不通过答案文件自动回答；
- 写入、进程、网络、MCP、凭据和发布能力只能由 Managed Policy 精确授权。

答案文件使用版本化 JSON：

```json
{
  "schemaVersion": 1,
  "manifests": [
    {
      "questionKey": "cli.output.format@1",
      "risk": "preference",
      "multiSelect": false,
      "optionIds": ["json", "text"],
      "preconfiguredAnswer": false,
      "allowAutoRecommended": false
    }
  ],
  "answers": {
    "cli.output.format@1": {
      "optionId": "json"
    }
  }
}
```

答案文件必须由当前用户或管理员拥有，不能是符号链接，并使用仅 Owner 可读写的私有权限。

Managed Policy 必须位于 Workspace 外，不能是符号链接，且 Owner 和文件/父目录权限必须可信。
Grant 绑定 canonical Workspace Path；`workspace.write` 不包含删除，`process.execute` 不包含
网络或发布。Managed Policy 不能把 read-only Workspace Trust 升级为写权限；无人值守写操作
必须同时具备 read-write Trust 和对应 Grant。自动回答和策略判定的脱敏审计写入
`~/.yiku/audit/cli-policy.ndjson`。

结构化完成结果：

```json
{
  "output": "任务输出",
  "sessionId": "session-id",
  "status": "completed",
  "usage": {},
  "verification": {}
}
```

NDJSON 流式输出 `session.started`、Stage、消息、Tool、Question、Checkpoint 和 Verification
事件，并以唯一的 `session.completed` 或 `session.failed` 结束。主要退出码：

| 退出码 | 含义 |
| ---: | --- |
| `0` | 成功 |
| `1` | 未分类运行或基础设施失败 |
| `2` | 参数、答案文件或 Policy 无效 |
| `3` | Workspace 未授权或授权读取失败 |
| `4` | Runtime、Hook 或 Policy 拒绝 |
| `5` | 需要用户输入或人工审批 |
| `6` | Eval 或未知副作用需要复核 |
| `7` | 预算暂停，可恢复 |
| `8` | Eval 决策为 `rejected` |
| `9` | Provider 或 MCP 外部依赖失败 |

## 配置

加载顺序：

YAML（后者覆盖前者）：

1. `~/.yiku/config.yaml`
2. `./config.yaml`

环境（后者覆盖前者）：

1. 进程环境
2. `./.env`
3. `~/.yiku/.env`
4. 命令行显式传入的环境

项目 `config.yaml` 覆盖同名全局 YAML 值；而全局 `~/.yiku/.env` 覆盖同名项目 `./.env`
值，避免项目占位密钥遮蔽全局配置。密钥应放在 `.env` 或进程环境，不写入 YAML。

最小配置：

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
      model: code
      skills: [agents, code, skills, tasks]
```

完整字段见 [配置与存储](../atoms/configuration-and-storage.md)。

## Prompt 输入

- `Enter`：提交；
- `Ctrl+J`：插入换行；
- `Up` / `Down`：浏览 Prompt 历史；
- `@`：递归模糊文件补全；
- `/`：Slash Command 补全；
- `Esc`：取消当前交互或运行；
- 连续两次 `Ctrl+C`：退出。

运行期间的新 Prompt 进入 FIFO 队列，不与当前模型回合并发执行。时间线使用 Append-only Static
输出，Assistant Markdown、Tool Call、Tool Result、Subagent 和错误都有独立展示。

提交前会拒绝空输入、异常控制字符和超出预算的 Prompt。History、Workspace/Project Instructions、
Memory、Project Skill、Hook Context 和 Tool Result 不进入可信 System Instructions，而是作为带
来源和 Digest 的不可信 Reference 输入。检测到常见 Prompt 注入特征时，CLI 显示
`Prompt risk detected`；该提示不替代 Hook、Permission、Workspace Access 或 Sandbox Policy。

## Slash Command

### 会话与状态

| 命令 | 用途 |
| --- | --- |
| `/status` | 查看 Session、Agent、模型和阶段状态 |
| `/context` | 查看 Context Window 使用情况 |
| `/usage` | 查看 Token 与费用摘要 |
| `/tasks` | 查看持久 Task |
| `/compact [instructions]` | 手工压缩上下文，可附加摘要要求 |
| `/cancel` | 取消当前运行 |
| `/clear` | 清空当前显示 |
| `/exit` | 关闭 Session 并退出 |

### Session 管理

| 命令 | 用途 |
| --- | --- |
| `/resume` | 选择并恢复 Session |
| `/rename` | 重命名当前 Session |
| `/branch` | 从当前状态创建分支 |
| `/rewind` | 恢复到 Checkpoint |
| `/copy` | 复制最近 Assistant 输出 |
| `/export` | 导出 Session Markdown |

`/rewind` 会恢复 Workspace Snapshot，可能覆盖目标 Checkpoint 之后的文件。无论直接传入
Checkpoint ID 还是从列表选择，都必须在 Checkpoint Picker 中再次确认后才执行。

### 能力管理

| 命令 | 用途 |
| --- | --- |
| `/memory` | 状态、搜索、整理和忘记 Memory |
| `/skills` | 查看、安装或创建 Skills |
| `/hooks` | 状态、信任、启停、Dry Run 和操作记录 |
| `/agents` | 查看、运行和管理 Session Subagent |
| `/agent-new` | 创建 Subagent Profile |
| `/model` | 切换模型 |
| `/mcp` | 查看和重连 MCP Server |
| `/output-style` | 切换输出样式 |

配置的 Skill 和持久化 Agent Profile 会进入 Slash Command 候选。输入 `/<skill-name>` 唤醒
Skill，输入 `/agent:<name>` 运行 Agent；`/skills` 和 `/agents` 分别查看完整目录。一次最多串联
六个 Skill。

`/skills install <source> [skill]` 从本地目录或公开 GitHub 仓库安装用户 Skill；
`/skills create <description>` 使用当前模型生成用户 Skill。两者成功后都会立即刷新当前会话的
Slash Command Catalog。

Slash Command 候选在固定高度菜单内随选中项滚动，当前可见描述完整换行且保持列对齐。菜单按
`GENERAL`、`SESSION`、`STATUS`、`RUNTIME`、`WORKFLOWS`、`AGENTS` 和 `SKILLS`
分组并使用不同标题颜色；所有 Skill 统一位于一个 `SKILLS` 分组。

### 工作流

| 命令 | 用途 |
| --- | --- |
| `/init` | 执行项目初始化 |
| `/doctor` | 运行本地诊断 |
| `/review` | 发起代码审查工作流 |
| `/spec:brainstorm` | 生成设计讨论 Prompt |
| `/spec:write-plan` | 生成实施计划 Prompt |
| `/spec:execute-plan` | 执行已批准计划 Prompt |
| `/spec:save-design` | 保存设计 Prompt |

工作流命令返回普通 Prompt，后续执行仍经过同一 Runtime、权限和 Eval。

## 运行期交互

CLI 承载五类阻塞交互：

- Code Tool 权限审批；
- Hook Trust；
- MCP Elicitation；
- AskUserQuestion；
- Session Resume Review。

Code Tool 权限审批提供“本次会话允许此权限”、“长期允许此策略”和“拒绝执行”。本次会话
批准后，相同 Workspace、工具、策略、能力、风险和命令或 MCP Target 的请求直接复用；目标或
权限范围变化时重新询问。Session Grant 仅保存在当前 CLI 进程内，不写入 Permission Profile；
展示被截断的命令不会缓存授权。

默认 Permission Profile 允许 `network.connect`，普通 Shell 网络命令不弹出审批。Profile 可将
网络默认值收紧为 `ask` 或 `deny`，远程脚本管道等 Runtime 硬拒绝不受默认值影响。

完整决策优先级、Profile Schema、Managed Policy 和 Sandbox 关系见
[Permission 与执行边界](permissions.md)。Compact 的阈值、摘要替换、Hook 与持久化语义见
[Context Compact](context-compaction.md)。

`AskUserQuestion` 支持单题和多题、单选和多选。结构化问题携带稳定 `questionKey`、风险类型和
稳定 `optionId`；问题语义或选项语义变化时必须提升 Key Major Version。等待期间 Runtime 暂停
阶段 Deadline，回答后继续原 Tool Call，不额外生成 User Message。等待期间会把问题请求写入
Session State，但不保存答案；进程重启后，普通问题使用明确标记的 reconstructed continuation，
`permission`、`secret` 或无法安全重建的问题保持 `needs-review`。

## Session 与恢复

每次交互使用一个持久 `SessionRuntime`。Stage 完成后保存 History、Task、预算、Checkpoint 和
副作用摘要。

- `--continue` 选择当前 Workspace 最新未完成 Session；
- `--resume` 按 ID 恢复；
- 未知外部副作用要求恢复复核；
- Provider 内部 `RunState` 不跨进程序列化；Pending Question 通过持久记录保守重建；
- Context 达到阈值时自动压缩。

Session 切换和模型替换期间 Prompt 输入暂停，Controller 同时串行化切换与 Submit；已经进入队列
的 Prompt 只会提交给切换完成后的当前 Session。取消或切换后的迟到 Progress/Usage Event 按 Run
ID 丢弃，不再污染下一轮 Context。

## Web 观测

```bash
yiku web --port 3333
```

命令启动本地 Agent Observatory，在同一终端进入交互会话，并把本次 Atomic Flow 投递到 Web
页面。端口占用时选择下一个可用端口；已有 Observatory 页面连接时不会重复打开浏览器。终端
退出时关闭本次服务。

## 状态位置

```text
~/.yiku/config.yaml
~/.yiku/.env
~/.yiku/permission/global.json
~/.yiku/audit/cli-policy.ndjson
~/.yiku/workspaces/<parent>_<workspace>[_<8-char-hash>]/
```

项目根只读取 `config.yaml` 和 `.env`。Session、日志、Eval 和 Memory 不写入项目目录。

CLI 向 Code Toolset 固定授权两个文件系统根：当前 Workspace 和 `~/.yiku`。相对路径仍从
Workspace 解析；`~/.yiku` 下的文件可以通过绝对路径或 `~/.yiku/...` 读写。Home 中其他目录、
名称相近的 `.yiku-*` 路径和经符号链接逃离授权根的目标保持硬拒绝。删除、移动、权限修改等
高风险操作即使位于授权根内，仍按 Permission Profile 审批。

## 常见错误

- `Workspace is not authorized`：先在交互终端运行 Yiku 并授权。
- `Provide a prompt argument`：提供 Prompt、`--continue`、`--resume` 或 `--init-only`。
- `CLI_APPROVAL_REQUIRED`：为对应 Workspace 和 Capability 提供受保护的 Managed Policy。
- `CLI_NEEDS_INPUT`：通过交互终端回答，或使用稳定 `questionKey` 配置 `--answers`。
- `CLI_REVIEW_REQUIRED`：恢复的副作用或敏感 Pending Input 无法安全自动重建。
- `--continue` 找不到 Session：当前 Workspace 没有未完成状态。
- `SHELL_SANDBOX_UNAVAILABLE`：当前平台缺少受支持隔离器。
- `needs-review` / `rejected`：检查结构化 Eval 结果或交互时间线中的失败 Check。

## 当前限制

- CLI 仍显式注册默认 Code/Research Factory，并读取 Agent Graph 生成 Hook、Eval 和展示配置；
  默认产品装配尚未完全收口到 Orchestrator。
- 持久 Agent Profile 只保存 Skill 名称，重启时从当前 Catalog 重建 Snapshot；Skill 文件变化会
  影响既有 Profile。
- Persistent Runtime 初始化在 Store Lease 建立后还要同步 Profile、Scope、MCP 和 Memory。若在
  资源登记完成前失败，当前进程可能持有 Lease 到 Session 显式关闭或进程退出。
- Web 无输入框：Observatory 只观测；输入仍在启动它的终端中完成。

## 验证

```bash
corepack pnpm --filter @yiku/cli build
corepack pnpm --filter @yiku/cli test
```

架构关系见 [Runtime 与编排](../architecture/runtime-and-orchestration.md)，多 Agent 消息协议见
[Agent-to-Agent 与 Subagents](subagents.md)。
