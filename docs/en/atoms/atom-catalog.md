# Atom Catalog

This document lists the currently public built-in Atomic Flow nodes. Keys come from the `*_ATOMS` and `*_ATOM_DEFINITIONS` exported by each package, and are the stable identifiers used for observation, Replay, and Studio layout.

## Runtime

Source: `@yiku/agent-orchestrator`

| Key | Kind | Label | Purpose |
| --- | --- | --- | --- |
| `run` | input | Run | Top-level run |
| `input.prompt` | input | Prompt Input | User input |
| `stage.start` | loop | Stage Start | Stage start |
| `stage.finish` | loop | Stage Finish | Stage terminal state |
| `session.resume` | loop | Session Resume | Session resumption |
| `session.checkpoint` | store | Checkpoint | Workspace/Session checkpoint |
| `agent.select` | agent | Agent Select | Agent selection |
| `loop.turn` | loop | Loop Turn | Model loop |
| `model.invoke` | model | Model Invoke | Model invocation |
| `tool.call` | tool | Tool Call | Tool execution |
| `runtime.boundary` | tool | Runtime Boundary | Shell isolation boundary change |
| `observation` | loop | Observation | Tool results enter the loop |
| `handoff` | handoff | Handoff | SDK Handoff |
| `user.question` | input | User Question | In-run user question |
| `action.gate` | action | Action Gate | Permission or action gate |
| `task.snapshot` | store | Task Snapshot | Task state snapshot |
| `subagent.lifecycle` | agent | Subagent | Subagent lifecycle |
| `context.compact` | context | Context Compact | Context Compaction |
| `usage.record` | usage | Usage | Token and resource usage |
| `reply.final` | reply | Final Reply | Final reply |
| `observability.degraded` | trace | Observability Degraded | Observability degradation |

## Agent and Skill Capability

Source: `@yiku/agent-orchestrator`

| Key | Kind | Purpose |
| --- | --- | --- |
| `agent.profile` | agent | Profile resolution and snapshot |
| `agent.spawn` | agent | Create an Agent Instance |
| `agent.execute` | agent | Agent execution |
| `agent.result` | agent | Agent result |
| `skill.resolve` | skill | Skill discovery and resolution |
| `skill.activate` | skill | Skill activation |
| `skill.execute` | skill | Skill Worker execution |

## Hooks

Source: `@yiku/agent-orchestrator`

| Key | Kind | Purpose |
| --- | --- | --- |
| `hook.dispatch` | hook | Hook Event dispatch and decision |
| `hook.execute` | hook | Single Handler execution |

The audit operations of `@yiku/hooks` also include `load` and `trust`, but the current Runtime Atom catalog exposes only Dispatch and Execute.

## Memory

Source: `@yiku/memories`

| Key | Level | Purpose |
| --- | --- | --- |
| `memory.recall` | runtime | Full recall flow |
| `memory.search` | runtime | Search entry point |
| `memory.fts-search` | deep | FTS candidates |
| `memory.query-embedding` | deep | Query Embedding |
| `memory.vector-search` | deep | Vector candidates |
| `memory.rerank` | deep | Fusion and reranking |
| `memory.context-inject` | runtime | Inject into Agent Context |
| `memory.extract` | runtime | Session memory extraction |
| `memory.write` | runtime | Persistent write |
| `memory.forget` | runtime | Forget |
| `memory.prune` | runtime | Expiration cleanup |
| `memory.consolidate` | runtime | Duplicate consolidation |
| `memory.working` | runtime | Working Memory |
| `memory.working-capture` | runtime | Working Memory capture |
| `memory.scenario` | runtime | Scenario classification |
| `memory.procedure` | runtime | Procedure classification |
| `memory.semantic` | runtime | Semantic classification |

## Evals

Source: `@yiku/evals`

| Key | Kind | Purpose |
| --- | --- | --- |
| `eval.trigger` | eval | Trigger evaluation |
| `eval.attempt` | eval | Attempt lifecycle |
| `eval.flow-integrity` | eval | Flow integrity |
| `eval.final-output` | eval | Final output check |
| `eval.memory-safety` | eval | Memory safety |
| `eval.judge` | eval | Optional LLM Judge |
| `eval.scorecard` | eval | Scorecard |
| `eval.repair` | eval | Automatic repair |
| `eval.gate` | release | Completion gate |
| `eval.decision` | release | Completion Decision |

`evaluatorAtom(key, label)` can generate dynamic `eval.<key>` nodes. Custom Evaluators should use stable Keys that are unique within the namespace.

## Research

Source: `@yiku/agent-research`

| Key | Kind | Purpose |
| --- | --- | --- |
| `research.plan` | context | Research plan |
| `research.query` | input | Query construction |
| `research.search` | tool | Web Search |
| `research.evidence-record` | store | Evidence write |
| `research.corroborate` | action | Cross-corroboration and refutation |
| `research.synthesize` | model | Comprehensive synthesis |
| `research.citation-validate` | eval | Citation validation |
| `research.report` | reply | Research report |

## Flow and Trajectory

Source: `@yiku/atomic-flow`, `@yiku/trajectory`

| Key | Kind | Purpose |
| --- | --- | --- |
| `flow.sink-error` | trace | Sink degradation |
| `trace.append` | trace | Persistent Trace Receipt |
| `trajectory.project` | trajectory | Compatibility Trajectory projection Receipt |

A standard Orchestrator does not need to emit `trajectory.project` to generate trajectories; Observatory and `projectTrajectory()` project directly from Atomic Flow Events.

## Definitions and Instances

Keys in the catalog represent definitions, not a single run. Event correlation should use:

- `event.instance.id`: one execution;
- `event.instance.parentId`: parent execution;
- `event.instance.iteration`: loop count;
- `event.edge.fromInstanceId`: precise source;
- `event.sequence`: order within a Run.

Do not use "the most recent Atom with the same name" in place of a known Instance ID.

## Extension Rules

- Keys use a lowercase dotted namespace, for example `checkout.payment-authorize`.
- Labels are human-facing and do not participate in identity determination.
- Choose the Kind with the closest existing semantics.
- Only high-frequency internal steps use `deep`.
- Keep Payloads bounded, serializable, and sanitized.
- Domain packages define Atoms; executors or Observers emit Events.
- A new Atom requires adding both protocol tests and Studio degradation display tests.

For the event protocol, see [Atomic Flow](atomic-flow.md).
