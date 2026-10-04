# @yiku/agent-code

`@yiku/agent-code` 定义 `CodeAgent`、Prompt、Code Skill、代码工具、基础权限协议和 Workspace
边界。它不运行 Session；模型配置、Handoff、Delegate、Hooks、Trace、Memory 和 Evals 由
`@yiku/agent-orchestrator` 组合。

## 主要导出

- `CodeAgent`
- `CodeToolset` / `codeTools`
- `createCodeSkill`
- `bashTool`
- `grepTool`
- `lsTool`
- `treeTool`
- `textEditorTool`
- `todoWriteTool`
- `askUserTool`
- `WorkspaceContext`
- `CodeArtifactCollector`
- `VerificationCommandRunner`
- `createCodeEvalProfile` / `createCodeEvaluators`
- Prompt、Permission、Middleware 和 Trace 辅助 API

## Toolset

| Access Mode | 工具 |
| --- | --- |
| `read-only` | Bash、Grep、Ls、Tree、TextEditor、TODO、AskUserQuestion；写操作先请求升级 |
| `read-write` | 同一稳定 Toolset；普通 Workspace 编辑直接运行 |

每个 Toolset 绑定不可变 `WorkspaceContext` 和 Session 级 `WorkspaceAccessController`。只读
Session 首次写入可升级为读写，升级后不重复询问。文件工具使用真实路径和符号链接边界；修改已有文件
采用同目录临时文件、File Sync、身份复检和 Rename。Bash 使用过滤环境、结构化 Token
分类、`allow | ask | deny` 策略和执行前路径检查。生产 Toolset 通过 `@yiku/sandbox` 在
macOS 使用 Sandbox Profile、在 Linux 使用 rootless `bubblewrap`。平台边界启动失败时，
Terminal 会显式切换 Host Policy、同步更新权限策略并发出边界变化事件；Verification Command
不接受该降级。

调用方必须执行 `CodeToolset.close()`。`codeTools()` 只返回 Tool 数组，无法向调用方暴露资源
关闭入口。

## Code Evals

Code Provider 生成文件 Before/After Digest、Scope、Symlink 和命令回执证据。Verification
Command 只接受结构化 `command + args`，默认禁网，保留有界 Head/Tail 和完整输出 Digest。
`isolated` 命令由 Orchestrator 在临时工作区执行，避免 lint/build/test 写入主工作区。

## 验证

```bash
corepack pnpm --filter @yiku/agent-code build
corepack pnpm --filter @yiku/agent-code test
```

## 权威文档

- [Code Agent](../../../docs/features/code-agent.md)
- [Permission 与执行边界](../../../docs/features/permissions.md)
- [Agent-to-Agent 与 Subagents](../../../docs/features/subagents.md)
- [Skills](../../../docs/features/skills.md)
- [Sandbox](../../../docs/atoms/sandbox.md)
- [Runtime 与编排](../../../docs/architecture/runtime-and-orchestration.md)
