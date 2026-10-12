# Code Agent

`@yiku/agent-code` defines the Code Agent, Prompt, Code Skill, Workspace tools, security boundaries, and Code Eval. It does not run Sessions; model, Handoff, Delegate, Hook, Memory, and Eval orchestration are the Orchestrator's responsibility.

## Creating an Agent

```ts
import { CodeAgent } from "@yiku/agent-code";

const agent = new CodeAgent({
  instructions: "优先执行最小、可验证的修改。",
  model: "your-model",
});
```

Yiku standard runs build the Agent via `CodeAgentFactory` and inject tools constrained by the current Agent configuration through `CapabilityScope`.

## Toolset

`CodeToolset` creates a stable tool set and shared resources for a Workspace:

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

Callers must close the Toolset. The compatibility function `codeTools()` returns only the tool array and cannot expose a resource-shutdown entry; new hosts should prefer holding a `CodeToolset`.

## Tools

| Tool | Capability | Writes |
| --- | --- | --- |
| `readTool` | Read text files and line ranges | No |
| `lsTool` | List directories | No |
| `treeTool` | Generate a bounded directory tree | No |
| `grepTool` | Search file contents by pattern | No |
| `editTool` | Perform exact replacements on existing files | Yes |
| `writeTool` | Create or overwrite files | Yes |
| `textEditorTool` | Compatible View/Create/Replace/Insert interface | Depends on operation |
| `bashTool` | Execute commands constrained by policy and Sandbox | Depends on command |
| `todoWriteTool` | Replace the current TODO list | State write |
| `askUserTool` | Request single- or multi-question answers | No |

The default Code Skill combines Workspace file, Shell, TODO, and user Q&A tools.

## Workspace Context

Every Toolset binds an immutable `WorkspaceContext`:

- All relative paths resolve from the Workspace root;
- Only the Workspace is allowed by default; the host can explicitly inject additional filesystem roots;
- The Yiku CLI injects only `~/.yiku` under the current Home and does not open up the entire Home;
- Absolute paths and `~/...`-expanded paths must lie within the allowed boundary;
- Symbolic link escapes are checked using Real Path;
- Target identity is re-verified before and after writes;
- Does not depend on the process-global `cwd`;
- Escaping the authorized root via `..`, link substitution, or in-command `cd` is not allowed.

File reads have caps on characters, lines, and match counts. Binary files, device files, oversized files, and invalid UTF-8 return structured errors rather than injecting arbitrary bytes into the model context.

Before every model call, the Orchestrator wraps text results from Code Tools, Hosted Tools, and Shell as `untrusted` References tagged with the Tool Name. Instructions in file contents and command output cannot override Agent Instructions, authorized write operations, or widen the Workspace boundary; the CLI and Trace still retain the original Tool Result for display and audit.

## File Modification

`editTool` requires the target text to exist and match uniquely; both zero matches and multiple matches fail. `writeTool` explicitly creates or overwrites based on the operation and cannot treat an unexpectedly existing target as a new file.

Modifying an existing file uses:

1. Read and record the target identity;
2. Create a temporary file in the same directory;
3. Write and perform File Sync;
4. Verify the target identity again;
5. Atomically replace via Rename.

This reduces partial writes and common link races, but does not provide transactions across multiple files. Multi-Agent shared writes are coordinated by the Orchestrator's `WorkspaceWriteLock`.

## Shell

`bashTool` first parses the command into structured Tokens, and then `ShellPolicy` produces `allow`, `ask`, or `deny`:

- Read-type commands can run directly;
- Ordinary network connections are allowed by default; the Permission Profile can tighten them to `ask` or `deny`;
- Writes, processes, and high-risk operations are approved by the Permission Handler;
- Explicitly dangerous or out-of-bounds commands are denied;
- Environment variables pass through an allowlist and sensitive-value filtering;
- Command output retains a bounded Head/Tail and a full Digest;
- Timeouts or cancellation terminate the process tree.

Production isolation:

| Platform | Isolator | Default network |
| --- | --- | --- |
| macOS | Sandbox Profile | Allowed |
| Linux | rootless `bubblewrap` | Allowed |
| Windows | Not supported | Denied |

Platform isolation is provided by the standalone `@yiku/sandbox`. A missing isolator, failed probe, or forbidden nesting returns `SHELL_SANDBOX_UNAVAILABLE`; the Sandbox package itself does not automatically widen the boundary. The Code Terminal explicitly switches to Host Policy, updates `ShellPolicy` synchronously, and emits a Runtime Boundary Change. High-risk combinations such as piping remote content directly into Shell remain hard denials. Eval Verification Commands require strong isolation, do not accept Host Policy, and use an independent explicit network policy that defaults to `deny`.

## Access Modes and Permissions

| Mode | Behavior |
| --- | --- |
| `read-only` | Stable tool set visible; the first write requests an upgrade |
| `read-write` | Ordinary authorized-root writes run directly; high-risk commands are still approved |

`WorkspaceAccessController` manages in-Session upgrades. After a successful upgrade, ordinary write permission is not requested again. Permission decisions still combine command risk, filesystem root boundaries, and host rules; project Prompts or Skills cannot grant permissions.

## TODO and User Questions

`todoWriteTool` replaces the entire list on every call, with states `pending`, `in_progress`, and `completed`, and at most one `in_progress` per list. The Orchestrator can map TODOs to a persistent Task Store via `TodoAdapter`.

`askUserTool` supports:

- One question or up to four questions;
- Single and multiple selection;
- Option Labels and Descriptions;
- Host-provided custom answers;
- Cancellation and timeout.

The tool defines only the protocol; the terminal UI is provided by the CLI.

## Middleware and Results

All tools execute through a unified Middleware:

1. Validate input;
2. Resolve Tool Effect;
3. Check Workspace Access and Permission;
4. Trigger Tool Hook;
5. Execute the tool;
6. Normalize `CodeToolResult`;
7. Generate Trace and display data.

Results distinguish model-visible text from host display data. Diffs, file excerpts, Shell, TODO, and errors can be rendered by the CLI using dedicated Presenters.

## Code Evals

The Code Agent provides:

- `CodeArtifactCollector`: generates file Before/After Digests, Scope, and Symlink evidence;
- `CodeArtifactIntegrityEvaluator`: checks Artifact consistency;
- `CodeChangeScopeEvaluator`: checks the modification scope;
- `VerificationCommandRunner`: executes structured verification commands;
- `CodeVerificationCommandEvaluator`: converts command results into Eval Checks;
- `createCodeEvalProfile()` / `createCodeEvaluators()`.

Verification Commands accept only `command + args` and are network-disabled by default. The `isolated` write policy runs in a temporary workspace, preventing artifacts generated by lint, build, or test from polluting the main Workspace.

## Main Exports

- `CodeAgent`
- `CodeToolset` / `codeTools`
- `createCodeSkill`
- `readTool` / `editTool` / `writeTool`
- `lsTool` / `treeTool` / `grepTool`
- `bashTool` / `textEditorTool`
- `todoWriteTool` / `askUserTool`
- `WorkspaceContext` / `WorkspaceAccessController`
- `ShellPolicy`
- Code Eval Collector, Runner, Profile, and Evaluator

Sandbox implementations and types are imported from `@yiku/sandbox`. The `@yiku/agent-code` root entry temporarily retains compatibility re-exports such as `PlatformShellSandbox`.

## Errors

Tool errors provide a stable Code, a readable message, and safe Details. Common types:

- Invalid input Schema or path;
- Workspace boundary escape or symbolic link escape;
- Permission denial;
- Non-unique text match;
- File identity changed during writing;
- Shell Sandbox unavailable;
- Command timeout, abort, or non-zero exit;
- Output exceeded limits and was truncated.

Errors do not contain API Keys, the full environment, unredacted command output, or file contents outside the Workspace.

## Verification

```bash
corepack pnpm --filter @yiku/agent-code build
corepack pnpm --filter @yiku/agent-code test
```

For the full permission decision chain, see [Permission and Execution Boundaries](permissions.md); for process isolation, see [Sandbox](../atoms/sandbox.md); for collaboration patterns, see [Agent-to-Agent and Subagents](subagents.md); for execution composition, see [Runtime and Orchestration](../architecture/runtime-and-orchestration.md).
