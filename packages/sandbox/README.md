# @yiku/sandbox

`@yiku/sandbox` 提供与 Agent、CLI 和权限实现无关的 Shell 进程隔离边界。它把允许访问的
Workspace、网络策略和运行时只读路径编译为可交给 Node `spawn()` 的启动描述。

## 平台

| 平台 | 隔离边界 | 网络控制 |
| --- | --- | --- |
| macOS | `/usr/bin/sandbox-exec` Profile | `allow` / `deny` |
| Linux | rootless `bubblewrap` Namespace | `allow` / `deny` |
| Windows | 暂不支持，显式失败 | 不适用 |

默认隔离器会在每次生成启动描述时执行可用性探针。缺少隔离器、探针失败、平台不支持或禁止
嵌套时抛出带稳定错误码 `SHELL_SANDBOX_UNAVAILABLE` 的
`ShellSandboxUnavailableError`，不会自行降级到 Host Shell。
显式 `sandboxExecutable` 同样会执行探针；`skipAvailabilityCheck` 只供测试或已完成等价探针的
受控宿主使用。

## 使用

```ts
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PlatformShellSandbox } from "@yiku/sandbox";

const rootDir = process.cwd();
const sandbox = new PlatformShellSandbox({ network: "deny" });
const launch = sandbox.createLaunchSpec({
  environment: process.env,
  shellPath: "/bin/bash",
  workspace: {
    rootDir,
    rootDirs: [rootDir],
    containsPath: (path) => path === rootDir || path.startsWith(`${rootDir}/`),
  },
  workspaceAccess: "read-only",
});

try {
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: { ...launch.environment },
    stdio: "pipe",
  });
  await once(child, "close");
} finally {
  sandbox.close();
}
```

调用方拥有子进程生命周期，并负责提供已经规范化、授权过的 Workspace Root。
`PlatformShellSandbox` 只生成和清理隔离边界，不解析命令、不授予权限，也不执行 Session。
`workspaceAccess` 默认为 `read-write`。必须等待所有使用该实例启动描述的子进程退出后再调用
`close()`；该方法幂等，并会清理 macOS 的实例私有临时目录。

`HostPolicyShellSandbox` 仅生成直接启动 Shell 的描述，供上层显式实现受策略控制的降级路径；
它的 `isolation` 为 `host-policy`，不是强隔离边界。

## 主要导出

- `PlatformShellSandbox`
- `HostPolicyShellSandbox`
- `ShellSandboxUnavailableError`
- `ShellProcessSandbox`
- `ShellSandboxLaunchInput` / `ShellSandboxLaunchSpec`
- `ShellSandboxWorkspace`
- `ShellIsolationLevel` / `ShellNetworkPolicy`

## 验证

```bash
corepack pnpm --filter @yiku/sandbox build
corepack pnpm --filter @yiku/sandbox test
```

完整边界和失败语义见 [Sandbox](../../docs/atoms/sandbox.md)。
