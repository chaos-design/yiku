import type { AtomicDefinition } from "@yiku/atomic-flow";
import type { HookOperation } from "@yiku/hooks";

export const RUNTIME_ATOMS = Object.freeze({
  actionGate: {
    key: "action.gate",
    kind: "action",
    label: "Action Gate",
    level: "runtime",
  },
  agentSelect: {
    key: "agent.select",
    kind: "agent",
    label: "Agent Select",
    level: "runtime",
  },
  contextCompact: {
    key: "context.compact",
    kind: "context",
    label: "Context Compact",
    level: "runtime",
  },
  handoff: {
    key: "handoff",
    kind: "handoff",
    label: "Handoff",
    level: "runtime",
  },
  inputPrompt: {
    key: "input.prompt",
    kind: "input",
    label: "Prompt Input",
    level: "runtime",
  },
  loopTurn: {
    key: "loop.turn",
    kind: "loop",
    label: "Loop Turn",
    level: "runtime",
  },
  modelInvoke: {
    key: "model.invoke",
    kind: "model",
    label: "Model Invoke",
    level: "runtime",
  },
  observation: {
    key: "observation",
    kind: "loop",
    label: "Observation",
    level: "runtime",
  },
  observabilityDegraded: {
    key: "observability.degraded",
    kind: "trace",
    label: "Observability Degraded",
    level: "runtime",
  },
  replyFinal: {
    key: "reply.final",
    kind: "reply",
    label: "Final Reply",
    level: "runtime",
  },
  runtimeBoundary: {
    key: "runtime.boundary",
    kind: "tool",
    label: "Boundary",
    level: "runtime",
  },
  run: {
    key: "run",
    kind: "input",
    label: "Run",
    level: "runtime",
  },
  sessionCheckpoint: {
    key: "session.checkpoint",
    kind: "store",
    label: "Checkpoint",
    level: "runtime",
  },
  sessionResume: {
    key: "session.resume",
    kind: "loop",
    label: "Session Resume",
    level: "runtime",
  },
  stageFinish: {
    key: "stage.finish",
    kind: "loop",
    label: "Stage Finish",
    level: "runtime",
  },
  stageStart: {
    key: "stage.start",
    kind: "loop",
    label: "Stage Start",
    level: "runtime",
  },
  subagentLifecycle: {
    key: "subagent.lifecycle",
    kind: "agent",
    label: "Subagent",
    level: "runtime",
  },
  taskSnapshot: {
    key: "task.snapshot",
    kind: "store",
    label: "Task Snapshot",
    level: "runtime",
  },
  toolCall: {
    key: "tool.call",
    kind: "tool",
    label: "Tool Call",
    level: "runtime",
  },
  usageRecord: {
    key: "usage.record",
    kind: "usage",
    label: "Usage",
    level: "runtime",
  },
  userQuestion: {
    key: "user.question",
    kind: "input",
    label: "User Question",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const CAPABILITY_ATOMS = Object.freeze({
  agentExecute: {
    key: "agent.execute",
    kind: "agent",
    label: "Agent Execute",
    level: "runtime",
  },
  agentProfile: {
    key: "agent.profile",
    kind: "agent",
    label: "Agent Profile",
    level: "runtime",
  },
  agentResult: {
    key: "agent.result",
    kind: "agent",
    label: "Agent Result",
    level: "runtime",
  },
  agentSpawn: {
    key: "agent.spawn",
    kind: "agent",
    label: "Agent Spawn",
    level: "runtime",
  },
  skillActivate: {
    key: "skill.activate",
    kind: "skill",
    label: "Skill Activate",
    level: "runtime",
  },
  skillExecute: {
    key: "skill.execute",
    kind: "skill",
    label: "Skill Execute",
    level: "runtime",
  },
  skillResolve: {
    key: "skill.resolve",
    kind: "skill",
    label: "Skill Resolve",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const HOOK_ATOMS = Object.freeze({
  dispatch: hookAtom("dispatch"),
  execute: hookAtom("execute"),
});

export const RUNTIME_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze([
  ...Object.values(RUNTIME_ATOMS),
  ...Object.values(CAPABILITY_ATOMS),
  ...Object.values(HOOK_ATOMS),
]);

export function hookAtom(operation: HookOperation, label = `Hook ${operation}`): AtomicDefinition {
  return {
    key: `hook.${operation}`,
    kind: "hook",
    label,
    level: "runtime",
  };
}
