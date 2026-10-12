# Sandbox

`@yiku/sandbox` is a standalone Node Shell process isolation package. It accepts an already authorized and normalized Workspace Root, network policy, and runtime read-only paths, and produces a launch spec that can be handed to `child_process.spawn()`.

## Boundaries

The Sandbox package owns:

- `ShellProcessSandbox`, launch input, and launch spec contracts;
- macOS Sandbox Profile;
- Linux rootless `bubblewrap` arguments;
- Isolator availability probes and stable errors;
- The lifecycle of the Sandbox's private temporary Home/Temp.

The Sandbox package does not own:

- Command parsing, risk classification, or permission approval;
- Child process startup, output, timeouts, and process tree management;
- Workspace authorization or Real Path validation;
- Agent, Session, CLI, or Eval semantics;
- Automatic Host Shell degradation.

Callers must provide an already validated `ShellSandboxWorkspace`, start and stop child processes, and call `sandbox.close()` after all child processes using the instance have exited.

## Platform Implementation

| Platform | Implementation | File System | Network |
| --- | --- | --- | --- |
| macOS | `/usr/bin/sandbox-exec` | Runtime read-only; Workspace read-only or read-write per policy | `allow` / `deny` |
| Linux | rootless `bubblewrap` | Runtime `ro-bind`; Workspace `ro-bind` or `bind` | Network Namespace |
| Windows | Not implemented | Explicit failure | Not applicable |

macOS uses a separate temporary Home, Temp, and Cache; Linux uses a separate `/tmp` and `/tmp/yiku-home`. Of the network policies, only `deny` cuts the network at the platform isolation layer; `ask` and `allowlist` still require an upper-layer policy to decide whether startup is allowed.

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

`launch.command`, `launch.args`, `launch.cwd`, and `launch.environment` form the complete launch spec. The package does not call `spawn()` itself, so it can be reused by persistent Shells, one-off Verification Commands, or other Node hosts. `workspaceAccess` defaults to `read-write`; read-only tasks must explicitly pass `read-only`.

## Lifecycle

- One instance can produce multiple launch specs; each call to `createLaunchSpec()` performs a platform availability probe unless the host explicitly sets `skipAvailabilityCheck`;
- macOS launch specs share the temporary Home, Temp, and Cache owned by the instance; `close()` deletes them;
- Linux uses each `bubblewrap` process's own tmpfs, which is not deleted by `close()`;
- `close()` is idempotent, but callers must not close the instance early while child processes are still using launch specs.

## Failure and Degradation

The default platform implementation probes the isolator every time it generates a launch spec. A missing executable, probe failure, unsupported platform, or unavailable nested isolation throws:

```text
SHELL_SANDBOX_UNAVAILABLE
```

An explicit `sandboxExecutable` must also pass the probe. `skipAvailabilityCheck` is only for deterministic tests, or controlled environments where the caller has already performed an equivalent availability check.

`PlatformShellSandbox` does not automatically widen boundaries. `HostPolicyShellSandbox` is an explicit direct launch spec that provides no strong isolation; it should be used only when the upper layer simultaneously switches the permission policy, records the boundary change, and accepts that risk.

The current Code Agent's `BashTerminal` emits one `uninitialized -> sandbox/container` Runtime Boundary Change after the first successful Shell startup; when platform-isolated startup fails, it switches to Host Policy and synchronously updates `ShellPolicy` and emits a `sandbox/container -> host-policy` event. Events enter the Session JSONL, Trace, host callbacks, and Atomic Flow's `runtime.boundary`. Verification Commands do not accept Host Policy and fail directly when strong isolation is missing.

## Verification

```bash
corepack pnpm --filter @yiku/sandbox build
corepack pnpm --filter @yiku/sandbox test
```
