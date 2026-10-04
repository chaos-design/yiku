# Skills

Yiku Skill 是带 Frontmatter 的 `SKILL.md`，用于向 Agent 提供可发现、可快照、可按需加载的
操作说明。Skill 描述能力，但不启动 Session，也不能提升父 Agent 权限。

## 目录与优先级

```text
@yiku/agent-orchestrator/src/skills/builtin/<name>/SKILL.md
~/.yiku/skills/<name>/SKILL.md
<workspace>/.yiku/skills/<name>/SKILL.md
```

同名时按 `project > user > builtin` 生效。低优先级项保留为 `SKILL_SHADOWED` 诊断；同一来源
出现重名时，该名称在该来源无效。

## 文件格式

```markdown
---
name: dependency-audit
description: 检查依赖健康度并输出有界报告。
version: 1.0.0
agentTypes:
  - code
mcp:
  - github/*
---

读取 Manifest、Lockfile 和安全公告。不要修改 Workspace。
输出证据、风险等级和升级顺序。
```

支持字段：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `name` | 是 | 必须与父目录名一致 |
| `description` | 是 | 用于 Catalog 和自动匹配 |
| `version` | 否 | 缺省为 `0.0.0-local` |
| `agentTypes` | 否 | 缺省为 `[code]` |
| `mcp` | 否 | 允许请求的 MCP Target Pattern |
| `allowed-tools` | 否 | Agent Skills 兼容元数据，不授予权限 |
| `license` | 否 | License 标识 |
| `compatibility` | 否 | 环境兼容说明 |
| `metadata` | 否 | 字符串键值元数据 |

未知字段、空名称、空描述、过大内容或错误类型产生诊断。Skill 目录可以包含 `scripts/`、
`references/` 和 `assets/`；正文相对路径以 Skill 根目录为基准。

## Discovery

```ts
import { discoverSkills } from "@yiku/agent-orchestrator";

const result = await discoverSkills({
  homeDir: process.env.HOME ?? "",
  workspaceDir: process.cwd(),
});
```

Discovery：

1. 并行读取内置、用户和项目目录；
2. 只接受目录或符号链接下的 `SKILL.md`；
3. 使用 Real Path 拒绝逃逸 Skill 根目录；
4. 解析 Frontmatter 和正文；
5. 计算规范化 SHA-256 Digest；
6. 处理同名优先级；
7. 返回有效 Skill、Shadowed Skill 和 Diagnostics。

单个无效文件不会阻止其他 Skill 加载。

### 配置式 Skill 与发现式 Skill

当前同时存在两条兼容链：

| 类型 | 来源 | 运行语义 |
| --- | --- | --- |
| 发现式 Skill | 上述三个目录中的 `<name>/SKILL.md` | 产生 Descriptor、Digest 和 Snapshot，执行 `agentTypes` 与 MCP Policy 校验；Project 来源作为不可信 Reference |
| 配置式 Skill | `config.yaml` 的 `skills.items.*` | 读取显式 Instructions 路径并注册到 `DefaultSkillRegistry`，作为带 Digest 的不可信 Project Reference，用于旧配置兼容 |

配置式 Skill 不自动转换为 `SkillDescriptor`，也不进入持久 Profile Snapshot。新 Skill 应使用
发现式目录格式；`skills.items` 主要保留既有 Instructions/MCP 配置。

## Skill Runtime

```ts
import { SkillRuntime, discoverSkills } from "@yiku/agent-orchestrator";

const runtime = new SkillRuntime({
  discovery: () =>
    discoverSkills({
      homeDir: process.env.HOME ?? "",
      workspaceDir: process.cwd(),
    }),
  isMcpTargetAllowed: (target) => target.startsWith("github/"),
});

await runtime.discover();
const catalog = runtime.list();
const snapshots = runtime.snapshot(["dependency-audit"], "code");
```

主要方法：

- `discover()`：替换 Catalog；
- `list()`：读取稳定排序 Descriptor；
- `inspect(name)`：查看单个 Skill；
- `snapshot(names, agentType)`：校验 Agent Type 和 MCP Policy，生成不可变 Snapshot；
- `diagnostics()` / `shadowed()`：读取最近发现结果。

Snapshot 固定 Instructions、Version、Source、Digest、Agent Types 和 MCP Targets。运行中的
Session Profile 持有完整 Snapshot；持久化 Agent Profile 目前只把 Skill 名称写入 Markdown，
重启加载时会从当前 Catalog 重建 Snapshot。因此 Skill 被修改、删除或 Shadow 后，持久 Profile
可能改变语义或加载失败；需要冻结长期语义的宿主应自行持久化完整 Snapshot。

## 激活方式

### 自动匹配

主 Agent 常驻有效 Skill 的名称和描述。描述与任务匹配时，通过 `skillInspectTool` 按需加载正文，
不相关 Instructions 不进入上下文。Builtin 和用户显式安装的 User Skill 可以提供 Agent
Instructions；Workspace 中的 Project Skill 只进入 `untrusted` Reference Channel，不能覆盖系统
指令、扩大 Tool Scope 或绕过权限。

### Slash Command

```text
/dependency-audit 检查当前 Workspace
```

Skill 会进入 `/` 补全候选，并只对本次提交生效。输入开头最多组合六个 Skill。
提交前 Runtime 使用当前 Agent Type 创建 Snapshot；例如 `agentTypes: [code]` 的 Skill 不能在
Research Agent 中通过 Slash Command 绕过校验。

### 隔离 Worker

`skillRunTool` 使用独立只读 Worker 运行 Snapshot：

```json
{
  "skill_name": "dependency-audit",
  "prompt": "检查当前 Workspace"
}
```

Worker 使用独立 Agent ID、Capability Scope、AbortSignal 和 Reader 并发预算。需要写能力的任务
应使用明确的 Read-write Subagent，而不是把写操作隐藏在 Skill 中。

## MCP

Frontmatter `mcp` 只缩小能力。每个 Target 必须同时满足：

- Server 已在 Runtime 配置中注册；
- Server Tool allowlist 允许；
- Managed Policy 未禁止；
- Skill Snapshot 声明允许；
- 当前 Agent Capability 允许。

Skill 不能通过 `mcp` 创建连接或绕过 Elicitation、Hook、Permission 和 Trust。

## 管理 Skill

项目 Skill 可以直接创建在：

```text
<workspace>/.yiku/skills/<name>/SKILL.md
```

CLI 还支持自然语言创建用户 Skill：

```text
/skills create 创建一个依赖审查技能
```

原有 `/skills <自然语言描述>` 仍兼容，等价于创建用户 Skill。生成结果固定使用本地版本、
`code` Agent Type 和空 MCP 列表。

CLI 可以从本地 Skill 目录或公开 GitHub 仓库安装：

```text
/skills install ./path/to/dependency-audit
/skills install owner/agent-skills dependency-audit
/skills install https://github.com/owner/agent-skills dependency-audit
```

来源只有一个 Skill 或仓库根目录包含 `SKILL.md` 时可以省略名称；存在多个 Skill 时必须提供
名称或来源内相对目录。GitHub 安装使用非交互浅克隆，需要本机提供 `git`，不会执行来源中的
脚本。

通过 CLI 安装或创建 Skill 时，目标固定为 `~/.yiku/skills/<name>/`，无需再次选择目录；项目
Skill 只通过直接编辑 Workspace 文件创建。安装会复制完整 Skill 目录，保留 `scripts/`、
`references/` 和 `assets/`，拒绝无效 Frontmatter、同名覆盖、符号链接、特殊文件和超限来源。
成功后当前 CLI 会话立即刷新 Catalog 和 Slash Command。

Store 使用私有目录、临时文件、File Sync 和原子替换，不覆盖同名 Skill，也不自动改名。

## 内置 Skills

Code Agent 随包提供：

```text
implementation-planning
test-driven-development
systematic-debugging
code-review
security-review
verification-before-completion
find-skills
skill-creator
```

内置工作流按需触发，不全部加入默认 `code + tasks` 能力集合。

## 原子事件

Skill 生命周期映射为：

```text
skill.resolve -> skill.activate -> skill.execute
```

`skill.execute` 的开始和终态使用同一 Worker Instance。Payload 只保存名称、来源、Digest 和 Worker
标识等摘要。

## 诊断与错误

| Code | 含义 |
| --- | --- |
| `SKILL_INVALID_FRONTMATTER` | Frontmatter、字段或正文无效 |
| `SKILL_DUPLICATE_NAME` | 同一来源重名 |
| `SKILL_SHADOWED` | 被高优先级来源覆盖 |
| `SKILL_PATH_ESCAPE` | Real Path 逃逸 Skill 根目录 |
| `SKILL_DISCOVERY_FAILED` | 目录或文件读取失败 |
| `SKILL_NOT_FOUND` | 运行时找不到名称 |
| `SKILL_AGENT_TYPE_MISMATCH` | Agent Type 不匹配 |
| `SKILL_CAPABILITY_DENIED` | MCP 或其他能力被 Policy 拒绝 |

## 公共入口

- `discoverSkills`
- `SkillRuntime`
- `SkillWorker`
- `createSkillRuntimeSkill`
- `ProjectSkillStore` / `UserSkillStore`
- `SkillCreationService`
- `SkillInstallationService`
- `parseSkillMarkdown`
- Descriptor、Snapshot、Diagnostic 和 Store 类型

## 验证

```bash
corepack pnpm --filter @yiku/agent-orchestrator test
corepack pnpm --filter @yiku/cli test
```
