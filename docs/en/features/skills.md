# Skills

A Yiku Skill is a `SKILL.md` with Frontmatter, used to provide Agents with discoverable, snapshot-able, on-demand-loadable operational instructions. A Skill describes capabilities but does not start a Session and cannot elevate the parent Agent's permissions.

## Directories and Priority

```text
@yiku/agent-orchestrator/src/skills/builtin/<name>/SKILL.md
~/.yiku/skills/<name>/SKILL.md
<workspace>/.yiku/skills/<name>/SKILL.md
```

When names collide, `project > user > builtin` takes effect. Lower-priority items are retained as `SKILL_SHADOWED` diagnostics; when duplicates appear within the same source, that name is invalid for that source.

## File Format

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

Supported fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Must match the parent directory name |
| `description` | Yes | Used for the Catalog and automatic matching |
| `version` | No | Defaults to `0.0.0-local` |
| `agentTypes` | No | Defaults to `[code]` |
| `mcp` | No | Permitted MCP Target Pattern for requests |
| `allowed-tools` | No | Agent Skills compatibility metadata; grants no permissions |
| `license` | No | License identifier |
| `compatibility` | No | Environment compatibility notes |
| `metadata` | No | String key-value metadata |

Unknown fields, empty names, empty descriptions, oversized content, or incorrect types produce diagnostics. A Skill directory can contain `scripts/`, `references/`, and `assets/`; relative paths in the body are resolved against the Skill root directory.

## Discovery

```ts
import { discoverSkills } from "@yiku/agent-orchestrator";

const result = await discoverSkills({
  homeDir: process.env.HOME ?? "",
  workspaceDir: process.cwd(),
});
```

Discovery:

1. Reads the builtin, user, and project directories in parallel;
2. Only accepts `SKILL.md` under a directory or symlink;
3. Uses Real Path to reject escapes from the Skill root directory;
4. Parses the Frontmatter and body;
5. Computes a normalized SHA-256 Digest;
6. Handles name-collision priority;
7. Returns valid Skills, Shadowed Skills, and Diagnostics.

A single invalid file does not prevent other Skills from loading.

### Configuration-based Skills and Discovery-based Skills

Two compatible chains currently coexist:

| Type | Source | Runtime Semantics |
| --- | --- | --- |
| Discovery-based Skill | `<name>/SKILL.md` in the three directories above | Produces a Descriptor, Digest, and Snapshot; performs `agentTypes` and MCP Policy validation; Project sources are treated as untrusted References |
| Configuration-based Skill | `skills.items.*` in `config.yaml` | Reads an explicit Instructions path and registers it with `DefaultSkillRegistry` as an untrusted Project Reference with a Digest, for legacy configuration compatibility |

Configuration-based Skills are not automatically converted to `SkillDescriptor` and do not enter the persistent Profile Snapshot. New Skills should use the discovery-based directory format; `skills.items` mainly retains existing Instructions/MCP configurations.

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

Main methods:

- `discover()`: replaces the Catalog;
- `list()`: reads stably sorted Descriptors;
- `inspect(name)`: views a single Skill;
- `snapshot(names, agentType)`: validates the Agent Type and MCP Policy, generating an immutable Snapshot;
- `diagnostics()` / `shadowed()`: reads the latest discovery results.

A Snapshot pins the Instructions, Version, Source, Digest, Agent Types, and MCP Targets. A running Session Profile holds the full Snapshot; the persisted Agent Profile currently only writes Skill names into Markdown, and rebuilds the Snapshot from the current Catalog on restart. Therefore, after a Skill is modified, deleted, or shadowed, the persistent Profile may change semantics or fail to load; hosts that need to freeze long-term semantics should persist the full Snapshot themselves.

## Activation Methods

### Automatic Matching

The main Agent keeps the names and descriptions of effective Skills resident. When a description matches the task, the body is loaded on demand via `skillInspectTool`, and irrelevant Instructions do not enter the context. Builtin Skills and User Skills explicitly installed by the user can provide Agent Instructions; Project Skills in the Workspace only enter the `untrusted` Reference Channel and cannot override system instructions, expand the Tool Scope, or bypass permissions.

### Slash Command

```text
/dependency-audit 检查当前 Workspace
```

Skills enter the `/` completion candidates and take effect only for the current submission. Up to six Skills can be combined at the start of the input. Before submission, the Runtime creates a Snapshot using the current Agent Type; for example, a Skill with `agentTypes: [code]` cannot bypass validation via a Slash Command in a Research Agent.

### Isolated Worker

`skillRunTool` uses an independent read-only Worker to run the Snapshot:

```json
{
  "skill_name": "dependency-audit",
  "prompt": "检查当前 Workspace"
}
```

The Worker uses an independent Agent ID, Capability Scope, AbortSignal, and Reader concurrency budget. Tasks requiring write capability should use an explicit Read-write Subagent rather than hiding write operations inside a Skill.

## MCP

The Frontmatter `mcp` field only narrows capabilities. Each Target must simultaneously satisfy:

- The Server is registered in the Runtime configuration;
- The Server Tool allowlist permits it;
- Managed Policy does not forbid it;
- The Skill Snapshot declares it allowed;
- The current Agent Capability allows it.

Skills cannot use `mcp` to create connections or bypass Elicitation, Hook, Permission, and Trust.

## Managing Skills

Project Skills can be created directly at:

```text
<workspace>/.yiku/skills/<name>/SKILL.md
```

The CLI also supports creating User Skills from natural language:

```text
/skills create 创建一个依赖审查技能
```

The original `/skills <natural-language description>` remains compatible and is equivalent to creating a User Skill. Generated results always use a local version, the `code` Agent Type, and an empty MCP list.

The CLI can install from a local Skill directory or a public GitHub repository:

```text
/skills install ./path/to/dependency-audit
/skills install owner/agent-skills dependency-audit
/skills install https://github.com/owner/agent-skills dependency-audit
```

The name can be omitted when the source contains only one Skill or the repository root contains a `SKILL.md`; when multiple Skills exist, a name or a relative directory within the source must be provided. GitHub installation uses a non-interactive shallow clone, requires `git` to be available locally, and does not execute scripts from the source.

When installing or creating a Skill via the CLI, the target is fixed at `~/.yiku/skills/<name>/`; no directory selection is needed again. Project Skills are created only by directly editing Workspace files. Installation copies the complete Skill directory, preserving `scripts/`, `references/`, and `assets/`, and rejects invalid Frontmatter, name collisions, symlinks, special files, and oversized sources. After success, the current CLI session immediately refreshes the Catalog and Slash Commands.

The Store uses private directories, temporary files, File Sync, and atomic replacement; it does not overwrite Skills with the same name and does not rename automatically.

## Builtin Skills

Code Agent ships with:

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

Builtin workflows trigger on demand and are not all added to the default `code + tasks` capability set.

## Atomic Events

The Skill lifecycle maps to:

```text
skill.resolve -> skill.activate -> skill.execute
```

The start and terminal states of `skill.execute` use the same Worker Instance. The Payload only stores summaries such as the name, source, Digest, and Worker identifier.

## Diagnostics and Errors

| Code | Meaning |
| --- | --- |
| `SKILL_INVALID_FRONTMATTER` | Invalid Frontmatter, fields, or body |
| `SKILL_DUPLICATE_NAME` | Duplicate name within the same source |
| `SKILL_SHADOWED` | Overridden by a higher-priority source |
| `SKILL_PATH_ESCAPE` | Real Path escape from the Skill root directory |
| `SKILL_DISCOVERY_FAILED` | Directory or file read failure |
| `SKILL_NOT_FOUND` | Name not found at runtime |
| `SKILL_AGENT_TYPE_MISMATCH` | Agent Type mismatch |
| `SKILL_CAPABILITY_DENIED` | MCP or other capability denied by Policy |

## Public Entry Points

- `discoverSkills`
- `SkillRuntime`
- `SkillWorker`
- `createSkillRuntimeSkill`
- `ProjectSkillStore` / `UserSkillStore`
- `SkillCreationService`
- `SkillInstallationService`
- `parseSkillMarkdown`
- Descriptor, Snapshot, Diagnostic, and Store types

## Validation

```bash
corepack pnpm --filter @yiku/agent-orchestrator test
corepack pnpm --filter @yiku/cli test
```
