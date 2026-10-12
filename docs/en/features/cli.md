# CLI

`@yiku/cli` is Yiku's default terminal host. It handles arguments, Workspace authorization, Prompt input, completion, approval, Slash Commands, the timeline, and structured output; Agent execution is performed by `@yiku/agent-orchestrator`.

## Startup

Repository development:

```bash
corepack pnpm build
corepack pnpm dev "审查当前仓库"
```

After installation or link:

```bash
yiku
yiku --agent reviewer "审查认证边界"
yiku --continue
yiku --resume <session-id>
yiku web --port 3333
```

## Options

| Option | Description |
| --- | --- |
| `--agent <key>` | Select the Agent in `config.yaml` |
| `--answers <file>` | Non-interactive answers file, matched by stable `questionKey` |
| `--init` | Run project initialization before the Prompt |
| `--init-only` | Run only initialization and exit |
| `--maintenance` | Run the maintenance flow before the Prompt |
| `--continue` | Resume the latest unfinished Session in the current Workspace |
| `--resume <id>` | Resume the specified Session |
| `--output <format>` | Output `text`, `json`, or `ndjson` |
| `--policy <file>` | Non-interactive Managed Policy that pre-authorizes exact Capabilities |
| `web --port <port>` | Start the local Observatory and an interactive session |
| `web --stop` | Clean up registered stale background observers |

`--output-format` is a compatibility alias for `--output`. `--resume` and `--continue` are mutually exclusive. The default port for `yiku web` is `4317`. Unknown options and a `--agent` missing its value fail immediately; when the Prompt itself must start with `-`, use `--` to terminate Option parsing:

```bash
yiku -- "--literal prompt"
```

## Interactive and Non-interactive

### Interactive Mode

When the terminal supports Raw Mode, the Ink UI starts. Entering a Workspace for the first time requires authorization:

- Read/write this time;
- Persistent read/write;
- Deny.

Ordinary read/write is not requested again when a valid authorization already exists; risky commands are still approved according to the Permission Profile.

### Non-interactive Mode

Without a TTY, the Prompt runs directly with text output, and machine protocols can also be selected explicitly. The Workspace must already be authorized in interactive mode:

```bash
yiku "检查项目状态"
yiku --output json --answers ~/.yiku/automation/answers.json "执行预配置任务"
yiku --output ndjson --policy ~/.yiku/policy/ci.json "运行 CI 检查"
yiku --output ndjson --continue
```

Non-interactive mode never pops up an approval UI and is uniformly fail-closed:

- Workspace Trust only decides `read-only` or `read-write` and does not approve specific side effects;
- No general-purpose `--yes` is provided;
- Questions lacking a stable `questionKey` pause, and the first option is no longer auto-selected;
- `preference` can be auto-selected only when both a trusted code-side Manifest and the question request allow it and the recommended `optionId` matches; a model request alone cannot establish a trusted Manifest;
- `required-input` can proceed only when the question allows preconfiguration and the answers file provides a stable `optionId`;
- `permission` and `secret` are never auto-answered through an answers file;
- Write, process, network, MCP, credential, and publish capabilities can only be precisely authorized by a Managed Policy.

The answers file uses versioned JSON:

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

The answers file must be owned by the current user or an administrator, must not be a symbolic link, and must use private permissions readable and writable only by the owner.

A Managed Policy must live outside the Workspace, must not be a symbolic link, and its owner and file/parent-directory permissions must be trusted. A Grant binds to the canonical Workspace Path; `workspace.write` does not include deletion, and `process.execute` does not include network or publishing. A Managed Policy cannot upgrade a read-only Workspace Trust into write permission; unattended write operations must have both read-write Trust and the corresponding Grant. Redacted audits of auto-answers and policy decisions are written to `~/.yiku/audit/cli-policy.ndjson`.

Structured completion result:

```json
{
  "output": "任务输出",
  "sessionId": "session-id",
  "status": "completed",
  "usage": {},
  "verification": {}
}
```

NDJSON streams `session.started`, Stage, message, Tool, Question, Checkpoint, and Verification events and ends with a single `session.completed` or `session.failed`. Main exit codes:

| Exit code | Meaning |
| ---: | --- |
| `0` | Success |
| `1` | Unclassified run or infrastructure failure |
| `2` | Invalid argument, answers file, or Policy |
| `3` | Workspace not authorized or authorization read failure |
| `4` | Runtime, Hook, or Policy denial |
| `5` | User input or manual approval required |
| `6` | Eval or unknown side effect requires review |
| `7` | Budget pause, resumable |
| `8` | Eval decision is `rejected` |
| `9` | Provider or MCP external dependency failure |

## Configuration

Load order:

YAML (later entries override earlier ones):

1. `~/.yiku/config.yaml`
2. `./config.yaml`

Environment (later entries override earlier ones):

1. Process environment
2. `./.env`
3. `~/.yiku/.env`
4. Environment explicitly passed on the command line

A project `config.yaml` overrides same-named global YAML values, while the global `~/.yiku/.env` overrides same-named project `./.env` values, preventing project placeholder keys from shadowing the global configuration. Secrets should be placed in `.env` or the process environment and must not be written to YAML.

Minimal configuration:

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

See [Configuration and Storage](../atoms/configuration-and-storage.md) for the full field reference.

## Prompt Input

- `Enter`: submit;
- `Ctrl+J`: insert a line break;
- `Up` / `Down`: browse Prompt history;
- `@`: recursive fuzzy file completion;
- `/`: Slash Command completion;
- `Esc`: cancel the current interaction or run;
- Two consecutive `Ctrl+C`: exit.

New Prompts during a run enter a FIFO queue and do not execute concurrently with the current model round. The timeline uses Append-only Static output, with dedicated rendering for Assistant Markdown, Tool Call, Tool Result, Subagent, and errors.

Empty input, abnormal control characters, and over-budget Prompts are rejected before submission. History, Workspace/Project Instructions, Memory, Project Skill, Hook Context, and Tool Result do not enter trusted System Instructions; instead they serve as untrusted Reference input carrying source and Digest. When common Prompt injection signatures are detected, the CLI displays `Prompt risk detected`; this notice does not replace Hook, Permission, Workspace Access, or Sandbox Policy.

## Slash Command

### Session and Status

| Command | Purpose |
| --- | --- |
| `/status` | View Session, Agent, model, and Stage status |
| `/context` | View Context Window usage |
| `/usage` | View Token and cost summary |
| `/tasks` | View persistent Tasks |
| `/compact [instructions]` | Manually compact context, with optional summary requirements |
| `/cancel` | Cancel the current run |
| `/clear` | Clear the current display |
| `/exit` | Close the Session and exit |

### Session Management

| Command | Purpose |
| --- | --- |
| `/resume` | Select and resume a Session |
| `/rename` | Rename the current Session |
| `/branch` | Create a branch from the current state |
| `/rewind` | Restore to a Checkpoint |
| `/copy` | Copy the most recent Assistant output |
| `/export` | Export Session Markdown |

`/rewind` restores the Workspace Snapshot and may overwrite files after the target Checkpoint. Whether the Checkpoint ID is passed directly or chosen from a list, execution requires confirmation again in the Checkpoint Picker.

### Capability Management

| Command | Purpose |
| --- | --- |
| `/memory` | Status, search, organize, and forget Memory |
| `/skills` | View, install, or create Skills |
| `/hooks` | Status, trust, enable/disable, Dry Run, and operation records |
| `/agents` | View, run, and manage Session Subagents |
| `/agent-new` | Create a Subagent Profile |
| `/model` | Switch models |
| `/mcp` | View and reconnect MCP Servers |
| `/output-style` | Switch the output style |

Configured Skills and persistent Agent Profiles enter the Slash Command candidates. Enter `/<skill-name>` to invoke a Skill and `/agent:<name>` to run an Agent; view the full catalogs with `/skills` and `/agents` respectively. Up to six Skills can be chained at once.

`/skills install <source> [skill]` installs a user Skill from a local directory or a public GitHub repository; `/skills create <description>` generates a user Skill with the current model. On success, both immediately refresh the current session's Slash Command Catalog.

Slash Command candidates scroll with the selection within a fixed-height menu, the currently visible description wraps in full while column alignment is preserved. The menu groups by `GENERAL`, `SESSION`, `STATUS`, `RUNTIME`, `WORKFLOWS`, `AGENTS`, and `SKILLS` and uses distinct heading colors; all Skills live in a single `SKILLS` group.

### Workflows

| Command | Purpose |
| --- | --- |
| `/init` | Run project initialization |
| `/doctor` | Run local diagnostics |
| `/review` | Start a code review workflow |
| `/spec:brainstorm` | Generate a design discussion Prompt |
| `/spec:write-plan` | Generate an implementation plan Prompt |
| `/spec:execute-plan` | Execute an approved plan Prompt |
| `/spec:save-design` | Save a design Prompt |

Workflow commands return ordinary Prompts, and subsequent execution still goes through the same Runtime, permissions, and Eval.

## Runtime Interaction

The CLI hosts five kinds of blocking interaction:

- Code Tool permission approval;
- Hook Trust;
- MCP Elicitation;
- AskUserQuestion;
- Session Resume Review.

Code Tool permission approval offers "Allow this permission for this session", "Allow this policy long-term", and "Deny execution". After approval for this session, requests with the same Workspace, tool, policy, capability, risk, and command or MCP Target are reused directly; the question is asked again when the target or permission scope changes. Session Grants are kept only in the current CLI process and are not written to the Permission Profile; a truncated command display does not cache authorization.

The default Permission Profile allows `network.connect`, so ordinary Shell network commands do not pop up approval. A Profile can tighten the network default to `ask` or `deny`; Runtime hard denials such as remote script piping are unaffected by the default.

For the full decision priority, Profile Schema, Managed Policy, and Sandbox relationship, see [Permission and Execution Boundaries](permissions.md). For Compact thresholds, summary replacement, Hook, and persistence semantics, see [Context Compaction](context-compaction.md).

`AskUserQuestion` supports single and multiple questions, and single and multiple selection. Structured questions carry a stable `questionKey`, risk type, and stable `optionId`; when question semantics or option semantics change, the Key Major Version must be raised. While waiting, the Runtime pauses the Stage Deadline; after answering, it continues the original Tool Call without generating an extra User Message. While waiting, the question request is written into Session State, but the answer is not saved; after a process restart, ordinary questions use an explicitly marked reconstructed continuation, while `permission`, `secret`, or questions that cannot be safely reconstructed remain `needs-review`.

## Session and Resumption

Each interaction uses one persistent `SessionRuntime`. After a Stage completes, History, Task, budget, Checkpoint, and side-effect summary are saved.

- `--continue` selects the latest unfinished Session in the current Workspace;
- `--resume` resumes by ID;
- Unknown external side effects require resumption review;
- Provider-internal `RunState` is not serialized across processes; Pending Questions are conservatively reconstructed through persistent records;
- Context is compacted automatically when it reaches the threshold.

Prompt input is paused during Session switching and model replacement, and the Controller serializes switching and Submit; Prompts already queued are submitted only to the current Session after switching completes. Late Progress/Usage Events after cancellation or switching are discarded by Run ID and no longer pollute the next round's Context.

## Web Observability

```bash
yiku web --port 3333
```

The command starts a local Agent Observatory, enters an interactive session in the same terminal, and delivers the current Atomic Flow to the web page. When the port is occupied, the next available port is chosen; an existing Observatory page connection does not reopen the browser. The service is closed when the terminal exits.

## State Locations

```text
~/.yiku/config.yaml
~/.yiku/.env
~/.yiku/permission/global.json
~/.yiku/audit/cli-policy.ndjson
~/.yiku/workspaces/<parent>_<workspace>[_<8-char-hash>]/
```

The project root reads only `config.yaml` and `.env`. Sessions, logs, Eval, and Memory are not written to the project directory.

The CLI always grants the Code Toolset two filesystem roots: the current Workspace and `~/.yiku`. Relative paths still resolve from the Workspace; files under `~/.yiku` can be read and written via absolute paths or `~/.yiku/...`. Other directories in Home, similarly named `.yiku-*` paths, and targets escaping the authorized roots via symbolic links remain hard-denied. High-risk operations such as deletion, moving, and permission changes are still approved according to the Permission Profile even inside the authorized roots.

## Common Errors

- `Workspace is not authorized`: run Yiku in an interactive terminal first and authorize it.
- `Provide a prompt argument`: provide a Prompt, `--continue`, `--resume`, or `--init-only`.
- `CLI_APPROVAL_REQUIRED`: provide a protected Managed Policy for the corresponding Workspace and Capability.
- `CLI_NEEDS_INPUT`: answer through the interactive terminal, or configure `--answers` with a stable `questionKey`.
- `CLI_REVIEW_REQUIRED`: resumed side effects or sensitive Pending Input cannot be safely reconstructed automatically.
- `--continue` finds no Session: the current Workspace has no unfinished state.
- `SHELL_SANDBOX_UNAVAILABLE`: the current platform lacks a supported isolator.
- `needs-review` / `rejected`: check the structured Eval result or the failed Check in the interactive timeline.

## Current Limitations

- The CLI still explicitly registers the default Code/Research Factory and reads the Agent Graph to generate Hook, Eval, and display configuration; default product assembly is not yet fully folded into the Orchestrator.
- Persistent Agent Profiles save only Skill names; on restart, the Snapshot is rebuilt from the current Catalog, so Skill file changes affect existing Profiles.
- Persistent Runtime initialization still syncs Profile, Scope, MCP, and Memory after the Store Lease is established. If it fails before resource registration completes, the current process may hold the Lease until the Session is explicitly closed or the process exits.
- The Web has no input box: the Observatory only observes; input still happens in the terminal that started it.

## Verification

```bash
corepack pnpm --filter @yiku/cli build
corepack pnpm --filter @yiku/cli test
```

For architecture relationships, see [Runtime and Orchestration](../architecture/runtime-and-orchestration.md); for the multi-Agent message protocol, see [Agent-to-Agent and Subagents](subagents.md).
