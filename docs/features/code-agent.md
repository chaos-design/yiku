# Code Agent

`@yiku/agent-code` 定义 Code Agent、Prompt、Code Skill、Workspace 工具、安全边界和 Code Eval。
它不运行 Session；模型、Handoff、Delegate、Hook、Memory 和 Eval 编排由 Orchestrator 负责。

## 创建 Agent

```ts
import { CodeAgent } from "@yiku/agent-code";

const agent = new CodeAgent({
  instructions: "优先执行最小、可验证的修改。",
  model: "your-model",
});
```

Yiku 标准运行使用 `CodeAgentFactory` 构建 Agent，并通过 `CapabilityScope` 注入受当前 Agent
配置限制的工具。

## Toolset

`CodeToolset` 为一个 Workspace 创建稳定工具集合和共享资源：

```ts
import { CodeToolset } from "@yiku/agent-code";

const toolset = new CodeToolset({
  accessMode: "read-write",
  cwd: process.cwd(),
});

try {
  const tools = toolset.tools;
  // 将 tools 提供给 Agent。
} finally {
  await toolset.close();
}
```

调用方必须关闭 Toolset。兼容函数 `codeTools()` 只返回工具数组，无法暴露资源关闭入口，新宿主
应优先持有 `CodeToolset`。

## 工具

| 工具 | 能力 | 写入 |
| --- | --- | --- |
| `readTool` | 读取文本文件和行范围 | 否 |
| `lsTool` | 列出目录 | 否 |
| `treeTool` | 生成有界目录树 | 否 |
| `grepTool` | 按模式搜索文件内容 | 否 |
| `editTool` | 对现有文件执行精确替换 | 是 |
| `writeTool` | 创建或覆盖文件 | 是 |
| `textEditorTool` | 兼容 View/Create/Replace/Insert 接口 | 视操作而定 |
| `bashTool` | 执行受策略与 Sandbox 约束的命令 | 视命令而定 |
| `todoWriteTool` | 替换当前 TODO 列表 | 状态写入 |
| `askUserTool` | 请求单题或多题回答 | 否 |

默认 Code Skill 组合 Workspace 文件、Shell、TODO 和用户问答工具。

## Workspace Context

每个 Toolset 绑定不可变 `WorkspaceContext`：

- 所有相对路径从 Workspace 根解析；
- 默认只允许 Workspace；宿主可以显式注入额外文件系统根；
- Yiku CLI 只额外注入当前 Home 下的 `~/.yiku`，不开放整个 Home；
- 绝对路径和 `~/...` 展开后的路径必须位于允许边界；
- 使用 Real Path 检查符号链接逃逸；
- 写入前后复检目标身份；
- 不依赖进程全局 `cwd`；
- 不允许通过 `..`、链接替换或命令内 `cd` 逃离授权根。

文件读取有字符、行数和匹配数量上限。二进制、设备文件、过大文件和无效 UTF-8 返回结构化错误，
不把任意字节注入模型上下文。

Orchestrator 在每次模型调用前把 Code Tool、Hosted Tool 和 Shell 的文本结果包装为带 Tool Name
的 `untrusted` Reference。文件内容和命令输出中的指令不能覆盖 Agent Instructions、授权写操作或
扩大 Workspace 边界；CLI 和 Trace 仍保留原始 Tool Result 用于展示与审计。

## 文件修改

`editTool` 要求目标文本存在且匹配唯一；零匹配或多匹配都失败。`writeTool` 根据操作显式创建或
覆盖，不能把意外存在的目标当作新文件。

修改已有文件使用：

1. 读取并记录目标身份；
2. 在同目录创建临时文件；
3. 写入并执行 File Sync；
4. 再次校验目标身份；
5. Rename 原子替换。

这样可以降低部分写入和常规链接竞态，但不能提供跨多个文件的事务。多 Agent 共享写入由
Orchestrator 的 `WorkspaceWriteLock` 协调。

## Shell

`bashTool` 先把命令解析为结构化 Token，再由 `ShellPolicy` 产生 `allow`、`ask` 或 `deny`：

- 读取型命令可以直接运行；
- 普通网络连接默认允许，Permission Profile 可以收紧为 `ask` 或 `deny`；
- 写入、进程和高风险操作按 Permission Handler 审批；
- 明确危险或越界命令拒绝；
- 环境变量经过 allowlist 和敏感值过滤；
- 命令输出保留有界 Head/Tail 和完整 Digest；
- 超时或取消终止进程树。

生产隔离：

| 平台 | 隔离器 | 默认网络 |
| --- | --- | --- |
| macOS | Sandbox Profile | 允许 |
| Linux | rootless `bubblewrap` | 允许 |
| Windows | 不支持 | 拒绝 |

平台隔离由独立的 `@yiku/sandbox` 提供。隔离器缺失、探针失败或禁止嵌套时返回
`SHELL_SANDBOX_UNAVAILABLE`；Sandbox 包本身不自动扩大边界。Code Terminal 会显式切换到
Host Policy、同步更新 `ShellPolicy` 并发出 Runtime Boundary Change。远程内容直接管道到
Shell 等高风险组合仍为硬拒绝。Eval Verification Command 要求强隔离，不接受 Host Policy，
并使用独立的显式网络策略，默认保持 `deny`。

## Access Mode 与权限

| 模式 | 行为 |
| --- | --- |
| `read-only` | 稳定工具集合可见，第一次写入先请求升级 |
| `read-write` | 普通授权根写入直接运行，高风险命令仍审批 |

`WorkspaceAccessController` 管理 Session 内升级。升级成功后不重复请求普通写权限。Permission
判断仍结合命令风险、文件系统根边界和宿主规则；项目 Prompt 或 Skill 不能授予权限。

## TODO 与用户提问

`todoWriteTool` 每次替换完整列表，状态为 `pending`、`in_progress`、`completed`，同一列表最多
一个 `in_progress`。Orchestrator 可以通过 `TodoAdapter` 把 TODO 映射到持久 Task Store。

`askUserTool` 支持：

- 单题或最多四题；
- 单选与多选；
- 选项 Label 和 Description；
- 宿主提供的自定义回答；
- 取消和超时。

工具只定义协议，终端 UI 由 CLI 提供。

## Middleware 与结果

所有工具通过统一 Middleware 执行：

1. 校验输入；
2. 解析 Tool Effect；
3. 检查 Workspace Access 和 Permission；
4. 触发 Tool Hook；
5. 执行工具；
6. 规范化 `CodeToolResult`；
7. 生成 Trace 和展示数据。

结果区分模型可见文本与宿主展示数据。Diff、文件片段、Shell、TODO 和错误可以由 CLI 使用专用
Presenter 渲染。

## Code Evals

Code Agent 提供：

- `CodeArtifactCollector`：生成文件 Before/After Digest、Scope 和 Symlink 证据；
- `CodeArtifactIntegrityEvaluator`：检查 Artifact 一致性；
- `CodeChangeScopeEvaluator`：检查修改范围；
- `VerificationCommandRunner`：执行结构化验证命令；
- `CodeVerificationCommandEvaluator`：把命令结果转为 Eval Check；
- `createCodeEvalProfile()` / `createCodeEvaluators()`。

Verification Command 只接受 `command + args`，默认禁网。`isolated` 写策略在临时工作区运行，
避免 lint、build 或 test 的生成文件污染主 Workspace。

## 主要导出

- `CodeAgent`
- `CodeToolset` / `codeTools`
- `createCodeSkill`
- `readTool` / `editTool` / `writeTool`
- `lsTool` / `treeTool` / `grepTool`
- `bashTool` / `textEditorTool`
- `todoWriteTool` / `askUserTool`
- `WorkspaceContext` / `WorkspaceAccessController`
- `ShellPolicy`
- Code Eval Collector、Runner、Profile 和 Evaluator

Sandbox 实现和类型从 `@yiku/sandbox` 导入。`@yiku/agent-code` 根入口暂时保留
`PlatformShellSandbox` 等兼容转发。

## 错误

工具错误提供稳定 Code、可读消息和安全 Details。常见类型：

- 输入 Schema 或路径无效；
- Workspace 越界或符号链接逃逸；
- 权限拒绝；
- 文本匹配不唯一；
- 文件身份在写入期间变化；
- Shell Sandbox 不可用；
- 命令超时、中止或非零退出；
- 输出超过限制并被截断。

错误不包含 API Key、完整环境、未脱敏命令输出或 Workspace 外文件内容。

## 验证

```bash
corepack pnpm --filter @yiku/agent-code build
corepack pnpm --filter @yiku/agent-code test
```

完整权限决策链见 [Permission 与执行边界](permissions.md)，进程隔离见
[Sandbox](../atoms/sandbox.md)，协作模式见 [Agent-to-Agent 与 Subagents](subagents.md)，执行组合见
[Runtime 与编排](../architecture/runtime-and-orchestration.md)。
