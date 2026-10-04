# Sandbox

`@yiku/sandbox` 是独立的 Node Shell 进程隔离包。它接收已经授权并规范化的 Workspace Root、
网络策略和运行时只读路径，生成可交给 `child_process.spawn()` 的启动描述。

## 边界

Sandbox 包拥有：

- `ShellProcessSandbox`、启动输入和启动描述契约；
- macOS Sandbox Profile；
- Linux rootless `bubblewrap` 参数；
- 隔离器可用性探针和稳定错误；
- Sandbox 私有临时 Home/Temp 的生命周期。

Sandbox 包不拥有：

- 命令解析、风险分类或权限审批；
- 子进程启动、输出、超时和进程树管理；
- Workspace 授权或 Real Path 校验；
- Agent、Session、CLI 或 Eval 语义；
- 自动 Host Shell 降级。

调用方必须提供已经验证的 `ShellSandboxWorkspace`，启动和关闭子进程，并在所有使用该实例的
子进程退出后调用 `sandbox.close()`。

## 平台实现

| 平台 | 实现 | 文件系统 | 网络 |
| --- | --- | --- | --- |
| macOS | `/usr/bin/sandbox-exec` | 运行时只读，Workspace 按策略只读或读写 | `allow` / `deny` |
| Linux | rootless `bubblewrap` | 运行时 `ro-bind`，Workspace `ro-bind` 或 `bind` | Network Namespace |
| Windows | 未实现 | 显式失败 | 不适用 |

macOS 使用独立临时 Home、Temp 和 Cache；Linux 使用独立 `/tmp` 与 `/tmp/yiku-home`。网络策略
只有 `deny` 会在平台隔离层断网；`ask` 和 `allowlist` 仍需要上层策略决定是否允许启动。

## API

```ts
import { PlatformShellSandbox } from "@yiku/sandbox";

const sandbox = new PlatformShellSandbox({
  network: "deny",
});

const launch = sandbox.createLaunchSpec({
  environment: process.env,
  shellPath: "/bin/bash",
  workspace: {
    rootDir: workspaceRoot,
    rootDirs: [workspaceRoot],
    containsPath: (path) =>
      path === workspaceRoot || path.startsWith(`${workspaceRoot}/`),
  },
  workspaceAccess: "read-only",
});
```

`launch.command`、`launch.args`、`launch.cwd` 和 `launch.environment` 是完整启动描述。包不会自行
调用 `spawn()`，因此可以被持久 Shell、一次性 Verification Command 或其他 Node 宿主复用。
`workspaceAccess` 默认为 `read-write`；只读任务必须显式传入 `read-only`。

## 生命周期

- 一个实例可以生成多个启动描述；每次调用 `createLaunchSpec()` 都会执行平台可用性探针，除非
  宿主显式设置 `skipAvailabilityCheck`；
- macOS 启动描述共享该实例拥有的临时 Home、Temp 和 Cache；`close()` 会删除它们；
- Linux 使用每个 `bubblewrap` 进程自己的 tmpfs，不由 `close()` 删除；
- `close()` 幂等，但调用方不能在仍有子进程使用启动描述时提前关闭实例。

## 失败与降级

默认平台实现在每次生成启动描述时探测隔离器。可执行文件缺失、探针失败、平台不支持或嵌套隔离
不可用时抛出：

```text
SHELL_SANDBOX_UNAVAILABLE
```

显式 `sandboxExecutable` 也必须通过探针。`skipAvailabilityCheck` 只用于确定性测试，或调用方
已经执行同等可用性检查的受控环境。

`PlatformShellSandbox` 不自动扩大边界。`HostPolicyShellSandbox` 是显式的直接启动描述，不提供
强隔离；只有上层在同步切换权限策略、记录边界变化并接受该风险时才应使用它。

当前 Code Agent 的 `BashTerminal` 在首次 Shell 启动成功后发出一次
`uninitialized -> sandbox/container` Runtime Boundary Change；平台隔离启动失败时切换到
Host Policy，并同步更新 `ShellPolicy`、发出 `sandbox/container -> host-policy` 事件。事件进入
Session JSONL、Trace、宿主回调和 Atomic Flow 的 `runtime.boundary`。Verification Command 不
接受 Host Policy，缺少强隔离时直接失败。

## 验证

```bash
corepack pnpm --filter @yiku/sandbox build
corepack pnpm --filter @yiku/sandbox test
```
