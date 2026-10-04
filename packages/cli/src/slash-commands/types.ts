import type {
  CheckpointRecord,
  McpRegistryStatusEntry,
  SessionState,
  SessionSubagentProfile,
  SkillSource,
  SubagentRunResult,
} from "@yiku/agent-orchestrator";
import type { MemoryController } from "../app/memory-controller.js";
import type { ContextUsageDetails } from "../app/session-metrics.js";
import type { HookController } from "../hooks/controller.js";

export interface SlashCommandClipboard {
  write(text: string): Promise<void>;
}

export interface SlashCommandExportResult {
  readonly filePath: string;
  readonly messageCount: number;
}

export interface SlashCommandSessions {
  checkpoints(): Promise<readonly CheckpointRecord[]>;
  currentSessionId(): Promise<string | undefined>;
  branch(title?: string): Promise<void>;
  list(): Promise<readonly SessionState[]>;
  remove(sessionId: string): Promise<void>;
  rename(title: string, sessionId?: string): Promise<void>;
  rewind(checkpointId: string): Promise<void>;
  switch(sessionId: string): Promise<void>;
}

export interface SlashCommandModelSummary {
  readonly key: string;
  readonly model: string;
  readonly provider?: string | undefined;
}

export interface SlashCommandRuntime {
  currentModel(): Promise<string | undefined>;
  mcpStatus(): Promise<readonly McpRegistryStatusEntry[]>;
  models(): Promise<readonly SlashCommandModelSummary[]>;
  outputStyle(): Promise<SessionState["outputStyle"]>;
  reconnectMcp(server: string): Promise<void>;
  setModel(modelKey: string, options: { readonly global: boolean }): Promise<void>;
  setOutputStyle(style: SessionState["outputStyle"]): Promise<void>;
}

export interface SlashCommandContext {
  readonly cancelActiveRun: () => void;
  readonly clearMessages: () => void;
  readonly clearQueuedPrompts: () => void;
  readonly clearSession: () => Promise<void>;
  readonly clipboard: SlashCommandClipboard;
  readonly compactContext: (instructions?: string) => Promise<void>;
  readonly createAgent: (intent: string | undefined) => Promise<SessionSubagentProfile>;
  readonly createSkill: (intent: string) => Promise<SlashCommandSkill>;
  readonly exit: () => void;
  readonly exportSession: (filePath?: string) => Promise<SlashCommandExportResult>;
  readonly getContextSummary: () => string;
  readonly getContextUsage: () => ContextUsageDetails | undefined;
  readonly getHookController: () => Promise<HookController | undefined>;
  readonly getMemoryController: () => Promise<MemoryController | undefined>;
  readonly getSessionStatus: () => string;
  readonly getTaskSummary: () => string;
  readonly getUsageSummary: () => string;
  readonly installSkill: (source: string, selector?: string) => Promise<SlashCommandSkill>;
  readonly listCommands: () => readonly SlashCommand[];
  readonly listAgents: () => Promise<readonly SessionSubagentProfile[]>;
  readonly listSkills: () => readonly SlashCommandSkill[];
  readonly lastAssistantText: () => string | undefined;
  readonly onExitCode: (code: number) => void;
  readonly removeAgent: (profileId: string) => Promise<void>;
  readonly runtime: SlashCommandRuntime;
  readonly runAgent: (profileId: string, prompt: string) => Promise<SubagentRunResult>;
  readonly runSetup: (trigger: "init" | "maintenance") => Promise<void>;
  readonly sessions: SlashCommandSessions;
  readonly showAgent: (profileId: string) => Promise<SessionSubagentProfile>;
}

export interface SlashCommandArguments {
  readonly raw: string;
  readonly values: readonly string[];
}

export type SlashCommandLineColor =
  | "cyan"
  | "gray"
  | "green"
  | "magenta"
  | "red"
  | "white"
  | "yellow";

export type SlashCommandResult =
  | {
      readonly kind: "error";
      readonly lineColors?: readonly SlashCommandLineColor[] | undefined;
      readonly lineIndents?: readonly number[] | undefined;
      readonly message: string;
      readonly title?: string | undefined;
    }
  | {
      readonly kind: "success";
      readonly contextUsage?: ContextUsageDetails | undefined;
      readonly lineColors?: readonly SlashCommandLineColor[] | undefined;
      readonly lineIndents?: readonly number[] | undefined;
      readonly message?: string | undefined;
      readonly title?: string | undefined;
    };

export interface SlashCommandSubmitResult {
  readonly activatedSkills: readonly string[];
  readonly commandArgs?: string | undefined;
  readonly commandName: string;
  readonly displayPrompt: string;
  readonly kind: "submit";
  readonly prompt: string;
}

export interface SlashCommandSkill {
  readonly description?: string | undefined;
  readonly digest?: string | undefined;
  readonly name: string;
  readonly path?: string | undefined;
  readonly source?: SkillSource | undefined;
  readonly version?: string | undefined;
}

export interface SlashCommandAgent {
  readonly deliverable: string;
  readonly description: string;
  readonly id: string;
  readonly name: string;
}

export interface SessionPickerOverlay {
  readonly currentSessionId?: string | undefined;
  readonly kind: "session-picker";
  readonly onDelete: (sessionId: string) => Promise<SlashCommandResult>;
  readonly onRename: (sessionId: string, title: string) => Promise<SlashCommandResult>;
  readonly onSelect: (sessionId: string) => Promise<SlashCommandResult>;
  readonly sessions: readonly SessionState[];
  readonly title: string;
}

export interface CheckpointPickerOverlay {
  readonly checkpoints: readonly CheckpointRecord[];
  readonly kind: "checkpoint-picker";
  readonly onSelect: (checkpointId: string) => Promise<SlashCommandResult>;
  readonly title: string;
}

export interface ModelPickerOverlay {
  readonly currentModel?: string | undefined;
  readonly kind: "model-picker";
  readonly models: readonly SlashCommandModelSummary[];
  readonly onSelect: (
    modelKey: string,
    options: { readonly global: boolean },
  ) => Promise<SlashCommandResult>;
  readonly title: string;
}

export interface McpManagerOverlay {
  readonly kind: "mcp-manager";
  readonly onReconnect: (server: string) => Promise<readonly McpRegistryStatusEntry[]>;
  readonly servers: readonly McpRegistryStatusEntry[];
  readonly title: string;
}

export interface OutputStylePickerOverlay {
  readonly currentStyle: SessionState["outputStyle"];
  readonly kind: "output-style-picker";
  readonly onSelect: (style: SessionState["outputStyle"]) => Promise<SlashCommandResult>;
  readonly title: string;
}

export type CommandOverlay =
  | CheckpointPickerOverlay
  | McpManagerOverlay
  | ModelPickerOverlay
  | OutputStylePickerOverlay
  | SessionPickerOverlay;

export interface SlashCommandBase {
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly execution?: "idle" | "immediate" | undefined;
  readonly name: string;
  readonly progressLabel?: string | undefined;
  readonly source?: "agent" | "builtin" | "skill" | undefined;
}

export interface LocalSlashCommand extends SlashCommandBase {
  readonly kind: "local";
  readonly execute: (
    context: SlashCommandContext,
    arguments_: SlashCommandArguments,
  ) => Promise<SlashCommandResult> | SlashCommandResult;
}

export interface PromptSlashCommand extends SlashCommandBase {
  readonly kind: "prompt";
  readonly getSubmission: (
    context: SlashCommandContext,
    arguments_: SlashCommandArguments,
  ) => Promise<SlashCommandSubmitResult> | SlashCommandSubmitResult;
}

export interface InteractiveSlashCommand extends SlashCommandBase {
  readonly kind: "interactive";
  readonly open: (
    context: SlashCommandContext,
    arguments_: SlashCommandArguments,
  ) => Promise<CommandOverlay | SlashCommandResult> | CommandOverlay | SlashCommandResult;
}

export type SlashCommand = LocalSlashCommand | PromptSlashCommand | InteractiveSlashCommand;

export type SlashCommandResolution =
  | {
      readonly arguments: SlashCommandArguments;
      readonly command: SlashCommand;
      readonly kind: "found";
    }
  | {
      readonly commandName: string;
      readonly kind: "invalid";
      readonly message: string;
    }
  | {
      readonly kind: "not-slash";
    }
  | {
      readonly commandName: string;
      readonly kind: "unknown";
    };
