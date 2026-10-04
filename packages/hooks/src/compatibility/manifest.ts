import { HOOK_EVENT_NAMES, type HookEventName, type HookExecutorType } from "../types.js";

export const CLAUDE_HOOKS_COMPATIBILITY_VERSION = "claude-hooks@2026-08-01";

export type HookCadence = "conditional" | "session" | "tool" | "turn";
export type HookDecisionCapability =
  | "allow"
  | "block"
  | "context"
  | "defer"
  | "modify"
  | "observe"
  | "stop";
export type ExitCodeTwoBehavior = "block" | "feedback" | "ignore";

export interface HookEventCapability {
  readonly cadence: HookCadence;
  readonly decisions: readonly HookDecisionCapability[];
  readonly exitCodeTwo: ExitCodeTwoBehavior;
  readonly handlers: readonly HookExecutorType[];
  readonly matcherField?: string | undefined;
  readonly runtimeSupported: boolean;
}

const ALL_HANDLERS = ["agent", "callback", "command", "http", "mcp", "prompt"] as const;
const OBSERVER_HANDLERS = ["callback", "command", "http", "mcp"] as const;

export const HOOK_EVENT_CAPABILITIES = Object.freeze({
  ConfigChange: capability("conditional", ["block", "observe"], "block", "source"),
  CwdChanged: capability("conditional", ["modify", "observe"], "feedback"),
  Elicitation: capability(
    "conditional",
    ["allow", "block", "modify", "observe"],
    "block",
    "mcp_server_name",
  ),
  ElicitationResult: capability(
    "conditional",
    ["block", "modify", "observe"],
    "block",
    "mcp_server_name",
  ),
  FileChanged: capability("conditional", ["modify", "observe"], "feedback", "file_path"),
  InstructionsLoaded: capability("conditional", ["context", "observe"], "feedback", "load_reason"),
  MessageDisplay: capability("turn", ["modify", "observe"], "feedback"),
  Notification: capability("conditional", ["observe"], "ignore", "notification_type", {
    handlers: OBSERVER_HANDLERS,
  }),
  PermissionDenied: capability("tool", ["context", "observe"], "feedback", "tool_name"),
  PermissionRequest: capability(
    "tool",
    ["allow", "block", "modify", "observe"],
    "block",
    "tool_name",
  ),
  PostCompact: capability("conditional", ["context", "observe"], "feedback", "trigger"),
  PostToolBatch: capability("tool", ["context", "observe"], "feedback"),
  PostToolUse: capability("tool", ["context", "observe"], "feedback", "tool_name"),
  PostToolUseFailure: capability("tool", ["context", "observe"], "feedback", "tool_name"),
  PreCompact: capability("conditional", ["block", "observe"], "block", "trigger"),
  PreToolUse: capability(
    "tool",
    ["allow", "block", "context", "defer", "modify", "observe"],
    "block",
    "tool_name",
  ),
  SessionEnd: capability("session", ["observe"], "ignore", "reason", {
    handlers: OBSERVER_HANDLERS,
  }),
  SessionStart: capability("session", ["context", "observe"], "feedback", "source"),
  Setup: capability("session", ["block", "context", "observe"], "block", "trigger"),
  Stop: capability("turn", ["block", "observe", "stop"], "block"),
  StopFailure: capability("turn", ["observe"], "ignore", "error_type", {
    handlers: OBSERVER_HANDLERS,
  }),
  SubagentStart: capability("conditional", ["context", "observe"], "feedback", "agent_type"),
  SubagentStop: capability("conditional", ["block", "observe", "stop"], "block", "agent_type"),
  TaskCompleted: capability("conditional", ["block", "observe"], "block"),
  TaskCreated: capability("conditional", ["block", "modify", "observe"], "block"),
  TeammateIdle: capability("conditional", ["block", "observe", "stop"], "block"),
  UserPromptExpansion: capability(
    "turn",
    ["block", "context", "modify", "observe"],
    "block",
    "command_name",
  ),
  UserPromptSubmit: capability("turn", ["block", "context", "observe"], "block"),
  WorktreeCreate: capability("conditional", ["block", "defer", "modify", "observe"], "block"),
  WorktreeRemove: capability("conditional", ["block", "defer", "observe"], "block"),
} satisfies Readonly<Record<HookEventName, HookEventCapability>>);

export const RUNTIME_HOOK_EVENT_NAMES = Object.freeze(
  HOOK_EVENT_NAMES.filter((name) => HOOK_EVENT_CAPABILITIES[name].runtimeSupported),
);

export function getHookEventCapability(name: HookEventName): HookEventCapability {
  return HOOK_EVENT_CAPABILITIES[name];
}

function capability(
  cadence: HookCadence,
  decisions: readonly HookDecisionCapability[],
  exitCodeTwo: ExitCodeTwoBehavior,
  matcherField?: string,
  overrides: {
    readonly handlers?: readonly HookExecutorType[] | undefined;
    readonly runtimeSupported?: boolean | undefined;
  } = {},
): HookEventCapability {
  return Object.freeze({
    cadence,
    decisions: Object.freeze([...decisions]),
    exitCodeTwo,
    handlers: Object.freeze([...(overrides.handlers ?? ALL_HANDLERS)]),
    ...(matcherField !== undefined ? { matcherField } : {}),
    runtimeSupported: overrides.runtimeSupported ?? true,
  });
}
