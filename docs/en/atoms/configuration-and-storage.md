# Configuration and Storage

`@yiku/config` provides YAML, `.env`, deep merging, and `~/.yiku` path resolution. The Orchestrator is responsible for parsing generic objects into strict model, Agent, Runtime, Skill, MCP, Memory, Flow, and Eval configuration.

## Configuration Sources

YAML:

1. `~/.yiku/config.yaml`
2. `<workspace>/config.yaml`

Project fields override user fields; when both values are objects they are merged recursively, while arrays and scalars are replaced wholesale.

Environment:

1. Startup process environment
2. `<workspace>/.env`
3. `~/.yiku/.env`
4. The `env` explicitly passed by the host

Later sources override same-named variables from earlier sources. Thus the global `~/.yiku/.env` overrides same-named variables from the project `<workspace>/.env`; this is the opposite of YAML, and exists so that a global model key is not shadowed by project placeholder values. `loadEnvFile()` reads only the explicit file and does not search parent directories.

## Models and Agents

```yaml
models:
  default: code
  items:
    code:
      name: your-openai-compatible-model
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.example.com/v1
      contextWindow: 128000
      agentName: Code Agent
      instructions: Be concise.

agents:
  default: code
  items:
    code:
      type: code
      model: code
      skills: [agents, code, skills, tasks]
      handoffs: []
      delegates: [reviewer]
    reviewer:
      type: code
      model: code
      skills: [code]
```

Model selection priority:

1. The persisted Session Model or the caller's explicit `modelKey`, including the value after a CLI `/model` switch;
2. The Agent Model corresponding to the CLI `--agent`;
3. `AI_MODEL`;
4. `models.default`;
5. `AI_MODEL_NAME`.

`AI_MODEL_NAME` can override the Provider Model Name, but the Model Key is still used for configuration selection.

API key resolution:

1. `AI_API_KEY_ENV`;
2. The Model Item `apiKeyEnv`;
3. Use that variable when `AI_API_KEY` exists;
4. `OPENAI_API_KEY` by default.

Keys belong only in `.env` or the process environment, and are not written to YAML.

## Runtime

```yaml
runtime:
  autoContinue: true
  compactAtContextRatio: 0.7
  compactToContextRatio: 0.25
  maxNoProgressStages: 2
  maxParallelReaders: 3
  maxStageDurationMs: 1800000
  maxStagesPerEpoch: 20
  maxToolCallsPerStage: 200
  maxTurnsPerStage: 100
```

`compactToContextRatio` must be less than `compactAtContextRatio`. Integer budgets all have hard upper limits, and unknown fields are rejected. For automatic and manual triggers, the token/character fallback algorithm, History replacement, and Hook ordering, see [Context Compact](../features/context-compaction.md).

## Memory, Flow, and Evals

```yaml
memory:
  enabled: true
  extraction: true
  failureMode: best-effort

flow:
  trace: false

evals:
  enabled: true
  mode: enforce
  maxConcurrentRuns: 8
  maxRepairAttempts: 1
  timeoutMs: 600000
  profiles: {}
```

`flow.trace` only controls whether internal Receipts and Sink Errors enter visible events; it does not turn off Atomic Flow.

## Skills and MCP

```yaml
skills:
  items:
    github:
      instructions: Use GitHub for source discovery.
      mcp: [github/search_*]

mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ["@modelcontextprotocol/server-github"]
      env: [GITHUB_TOKEN]
      tools: [search_*]
```

HTTP MCP:

```yaml
mcp:
  servers:
    remote:
      transport: streamable-http
      url: https://mcp.example.com/
      headers:
        Authorization: Bearer $MCP_TOKEN
      allowedEnvVars: [MCP_TOKEN]
      tools: ["*"]
```

HTTP URLs must be HTTPS and must not contain credentials, a Query, or a Fragment. Servers referenced by a Skill must exist, and are intersected with the Server Tool allowlist and the Managed Policy.

## Main Environment Variables

| Variable | Purpose |
| --- | --- |
| `YIKU_AGENT` | Default Agent Key |
| `AI_MODEL` | Model Key |
| `AI_MODEL_NAME` | Provider Model Name |
| `AI_API_KEY_ENV` | API key variable name |
| `AI_API_KEY` | Generic API key |
| `OPENAI_API_KEY` | Default API key |
| `AI_BASE_URL` / `OPENAI_BASE_URL` | OpenAI-compatible endpoint |
| `AI_AGENT_NAME` | Agent display name |
| `AI_INSTRUCTIONS` | Agent Instructions |
| `AI_CONTEXT_WINDOW` | Positive-integer Context Window |
| `YIKU_ATOMIC_STUDIO_URL` | Atomic Studio loopback endpoint |
| `YIKU_WORKSPACE_DIR` | Explicit Workspace for some hosts |

## Home Paths

```text
~/.yiku/
├── config.yaml
├── .env
├── permission/
│   └── global.json
├── memory/
│   └── memories.sqlite
├── skills/
│   └── <skill-name>/SKILL.md
├── workspaces/
│   └── <parent>_<workspace>[_<8-char-hash>]/
├── web.json
└── web.log
```

`web.json` and `web.log` are used only for web service registration and logging.

## Workspace Storage

`WorkspaceStorageLocator` first resolves the Workspace Real Path, then generates:

```text
<normalized-parent>_<normalized-workspace>
```

Rules:

- Unicode NFKC;
- Lowercase;
- Non-alphanumeric characters are replaced with `_`;
- Leading and trailing `_` are stripped;
- When a directory name already maps to a different Real Path, append `_` plus an 8-character SHA-256 digest;
- `workspace.json` records the owner `rootRealPath` with `0600`;
- Directories are created with `0700`;
- Claims use a temporary directory and atomic Rename.

Legacy `yiku_`-prefixed directories are not automatically scanned, reused, or migrated.

## Workspace Directory

```text
~/.yiku/workspaces/<storage-name>/
├── workspace.json
├── session/
├── logs/
│   ├── atomic-runs/
│   └── runs/
├── evals/
└── memory/
    └── memories.sqlite
```

- `session/`: Session state, Trace, message, and Checkpoint-related data;
- `logs/atomic-runs/`: source Atomic Flow JSONL;
- `logs/runs/`: Agent Studio/Observatory Runs;
- `evals/`: Plans, Attempts, Scorecards, Evidence, and Baselines;
- `memory/`: long-term project Memory.

Run data is not written to `<workspace>/.yiku`. The in-project `.yiku/skills` is a committable Skill definition, not Runtime Storage.

The CLI Code Tool's host boundary treats `~/.yiku` as the only additional filesystem root outside the Workspace. That authorization matches the directory boundary exactly and does not cover other Home contents; symlink escapes are still rejected. Deletions, moves, and other high-risk operations inside the directory continue to go through the Permission Profile and are not automatically allowed because of the storage location.

## Permission

`~/.yiku/permission/global.json` stores:

- Active Profile;
- Filesystem default mode;
- Network default decision;
- Command/MCP/Policy Rule;
- Shell Sandbox policy;
- Workspace read-only/read-write authorization;
- Authorization TTL.

The default authorization TTL is 7 days. File corruption, unknown Profiles, or invalid schemas fail explicitly rather than automatically widening permissions. A CLI Session Permission Grant exists only in the current process and is not written to this file; only "long-term allow this policy" updates the active Profile.

The default Profile's `network.default` is `allow`, so ordinary `network.connect` requests execute directly. Users can change it to `ask` or `deny` in a custom Profile; Runtime hard denials cannot be overridden by that default. When a legacy v1 Permission file is loaded, the built-in `default` Profile is migrated to this default value and written back atomically; the network decisions of custom named Profiles remain unchanged.

Hook Trust uses a separate Hook Trust Store whose path and lifecycle are provided by the CLI/host; it is not merged with Workspace Filesystem authorization.

This section only defines configuration and storage locations. For Permission Request fields, rule priority, Session/Persistent Grants, Managed Policy, Shell classification, and Sandbox execution boundaries, see [Permission and Execution Boundaries](../features/permissions.md).

## Public API

```ts
import {
  ConfigStore,
  loadEnvFile,
  loadModelsConfig,
  mergeConfig,
  mergeEnv,
  WorkspaceStorageLocator,
  YikuPaths,
} from "@yiku/config";
```

- `ConfigStore`: Revision-tracked YAML configuration updates;
- `loadModelsConfig()`: reads YAML into an object;
- `loadEnvFile()`: reads a single `.env`;
- `mergeConfig()` / `mergeEnv()`: deterministic merging;
- `WorkspaceStorageLocator`: safely claims Storage ownership;
- `YikuPaths`: generates all Home and Workspace paths.

## Failure Semantics

- A missing configuration file returns an empty object;
- YAML that is not an object returns an empty configuration, and strict fields are rejected during Orchestrator parsing;
- A missing API key prevents Agent creation;
- Unknown Skill, Delegate, MCP, or Eval Profile references prevent startup;
- A Workspace must be an existing, resolvable absolute path;
- Storage ownership conflicts use a digest name; if the digest conflicts again, it fails;
- Permission and Store writes use private permissions and atomic replacement.

## Verification

```bash
corepack pnpm --filter @yiku/config test
corepack pnpm --filter @yiku/agent-orchestrator test
corepack pnpm --filter @yiku/cli test
```
