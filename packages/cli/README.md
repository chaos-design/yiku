# @yiku/cli

`@yiku/cli` 是 Yiku 基于 Ink + React 的终端宿主。它负责参数、工作区授权、Prompt 输入、补全、
审批、Slash Command 和时间线展示；Agent 执行委托给 `@yiku/agent-orchestrator`。

## 运行

环境：

- Node.js `>=22.13.0`
- pnpm `11`

仓库开发：

```bash
corepack pnpm build
corepack pnpm dev "Review this repository"
```

安装或 Link 后：

```bash
yiku
yiku --agent reviewer "Review the authentication boundary"
yiku --continue
yiku --resume <session-id>
yiku web --port 3333
```

交互式对话要求 TTY。无 TTY 时直接运行 Prompt 使用文本输出，也可以通过
`--output text|json|ndjson` 选择输出协议；`--output-format` 作为兼容别名保留。非交互运行只
接受已授权 Workspace，未授权 Workspace 必须先在交互终端完成授权。`--answers <file>` 可按稳定
`questionKey` 提供预配置答案，`--policy <file>` 可按 Workspace、Capability 和 Resource Scope
预授权副作用。两类文件都必须显式传入；Managed Policy 必须位于 Workspace 外并通过 Owner、
权限和真实路径校验。

JSON 在结束时输出单个结果对象。NDJSON 逐行输出 `session.started`、`stage.started`、
`message.delta`、`tool.started`、`tool.completed`、`question.requested`、`checkpoint.saved`、
`verification.completed` 等进度事件，并以 `session.completed` 或 `session.failed` 结束。
协议内容只写 stdout，诊断与文本模式错误写 stderr。

非交互模式 fail-closed，不提供通用 `--yes`。Workspace Trust 只确定 `read-only` 或
`read-write` Access Mode，答案文件不能授予 Capability，高风险操作缺少 Managed Policy 时以
exit `5` 暂停。策略拒绝为 exit `4`，未知副作用复核为 exit `6`。自动回答和策略判定的脱敏审计
写入 `~/.yiku/audit/cli-policy.ndjson`。Managed Policy 不能把 read-only Trust 升级为写权限；
自动推荐还必须由代码侧可信问题 Manifest 授权，模型请求本身不能建立该信任。

等待中的 User Question 会以不含答案的 Pending Input 写入 Session State。进程重启后，普通问题
通过 `reconstructed-continuation` 明确恢复；敏感问题或无法安全重建的 Provider 状态返回
`CLI_REVIEW_REQUIRED`，不会伪装成原 Tool Call 继续。

工作区授权 UI 提供本次或长期读写授权，也可以拒绝退出。长期期限由
`~/.yiku/permission/global.json` 配置。

全局配置与密钥位于 `~/.yiku/config.yaml`、`~/.yiku/.env`，项目根
`config.yaml`、`.env` 按键覆盖全局值。Session、日志和项目 Memory 统一写入
`~/.yiku/workspaces/<parent>_<workspace>[_<8-char-hash>]/`；名称冲突时才追加 8 位路径摘要。
旧版带 `yiku_` 前缀的 Workspace Storage 目录不会被自动扫描或迁移。启动时已有有效读写权限则直接进入
程序；常规读写不重复询问，风险命令仍按 Permission Profile 审批。同一风险权限在当前 CLI
Session 批准后直接复用，只有目标或权限范围变化时再次询问。

Code Tool 只写入当前 Workspace 和 `~/.yiku`；Home 下其他目录及符号链接逃逸目标保持拒绝。

交互命令覆盖 Session 恢复、重命名、分支和回退，模型与 MCP 管理、输出样式、Review、
Skill 列表、安装和创建，剪贴板、Markdown 导出及四个 `/spec:*` 工作流。用户 Skill 可通过
`/skills install <source> [skill]` 从本地目录或公开 GitHub 仓库安装，成功后立即进入当前
Slash Command Catalog。命令类型、参数和副作用见
[CLI](../../docs/features/cli.md#slash-command)。

## 包边界

CLI 自有：

- `yiku` 参数和 TTY 入口；
- Ink App 和 Static Timeline；
- Prompt 编辑、历史、Slash/File Completion 和 FIFO；
- Permission、Hook Trust、MCP Elicitation、Resume Review、AskUserQuestion；
- `yiku web` 前台生命周期；
- Session、Context、Usage、Task 和 Tool 展示。

CLI 不自有：

- Agent Graph、Runner 和 Session State；
- Code Tools 和 Research Evidence；
- Hook Engine、Memory Store、MCP Registry；
- Atomic Flow 和 Eval 协议。

## 开发

```bash
corepack pnpm --filter @yiku/cli build
corepack pnpm --filter @yiku/cli watch
corepack pnpm --filter @yiku/cli test
corepack pnpm --filter @yiku/cli dev
```

`packages/cli/bin/yiku.js` 始终启动 `dist/index.js`。
包根 `@yiku/cli` 只导出 `runCliRuntime()` 和 `supportsRawMode()`；导入 Package 不会自动启动 CLI。

`watch` 只执行 TypeScript 增量编译。`dev` 监听 CLI、运行时依赖和 Agent Observatory 资源，
构建成功后从 Binary 重启。

## 权威文档

- [CLI](../../docs/features/cli.md)
- [Runtime 与编排](../../docs/architecture/runtime-and-orchestration.md)
- [Context Compact](../../docs/features/context-compaction.md)
- [Permission 与执行边界](../../docs/features/permissions.md)
- [Agent-to-Agent 与 Subagents](../../docs/features/subagents.md)
- [Atomic Flow](../../docs/atoms/atomic-flow.md)
- [Trajectory](../../docs/atoms/trajectory.md)
- [配置与存储](../../docs/atoms/configuration-and-storage.md)
