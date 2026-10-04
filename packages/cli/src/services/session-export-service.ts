import { randomUUID } from "node:crypto";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentMessageEnvelope,
  AgentMessagePayload,
  AgentUsage,
} from "@yiku/agent-orchestrator";
import { HookRedactor, type JsonValue } from "@yiku/hooks";

const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_ENTRIES = 50;
const MAX_STRUCTURED_CHARS = 16_000;
const MAX_STRUCTURED_DEPTH = 5;
const MAX_STRING_CHARS = 4_000;

export interface SessionExportServiceOptions {
  readonly eventLogPath: string;
  readonly exportsDir: string;
  readonly model?: string | undefined;
  readonly title?: string | undefined;
  readonly workspaceDir: string;
}

export interface SessionExportInput {
  readonly filePath?: string | undefined;
  readonly sessionId: string;
}

export interface SessionExportResult {
  readonly filePath: string;
  readonly messageCount: number;
}

interface AssistantBuffer {
  readonly agentId: string;
  text: string;
}

export class SessionExportService {
  private readonly eventLogPath: string;
  private readonly exportsDir: string;
  private readonly model?: string | undefined;
  private readonly redactor = new HookRedactor();
  private readonly title?: string | undefined;
  private readonly workspaceDir: string;

  public constructor(options: SessionExportServiceOptions) {
    this.eventLogPath = requireAbsolutePath(options.eventLogPath, "Session event log");
    this.exportsDir = requireAbsolutePath(options.exportsDir, "Session exports directory");
    this.model = options.model?.trim() || undefined;
    this.title = options.title?.trim() || undefined;
    this.workspaceDir = requireAbsolutePath(options.workspaceDir, "Workspace");
  }

  public async export(input: SessionExportInput): Promise<SessionExportResult> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      throw new Error("Session ID is required for export.");
    }

    const filePath = await this.resolveFilePath(input.filePath, sessionId);
    const events = parseEventLog(await readFile(this.eventLogPath, "utf8"), sessionId);
    const projection = this.project(events, sessionId);
    await writeAtomicArtifact(filePath, projection.markdown);
    return {
      filePath,
      messageCount: projection.messageCount,
    };
  }

  private project(
    events: readonly AgentMessageEnvelope[],
    sessionId: string,
  ): { readonly markdown: string; readonly messageCount: number } {
    const entries: string[] = [];
    let assistant: AssistantBuffer | undefined;

    const flushAssistant = () => {
      if (assistant === undefined) {
        return;
      }
      if (assistant.text.trim()) {
        entries.push(
          [
            `## Assistant${assistant.agentId === "root" ? "" : `: ${heading(assistant.agentId)}`}`,
            "",
            this.redactor.redactText(assistant.text),
          ].join("\n"),
        );
      }
      assistant = undefined;
    };

    for (const event of events) {
      const payload = event.payload;
      if (payload.kind === "assistant_delta") {
        if (assistant?.agentId === event.agentId) {
          assistant.text += payload.text;
        } else {
          flushAssistant();
          assistant = { agentId: event.agentId, text: payload.text };
        }
        continue;
      }

      flushAssistant();
      const rendered = this.renderEvent(event);
      if (rendered !== undefined) {
        entries.push(rendered);
      }
    }
    flushAssistant();

    const header = [
      "# Yiku Session Export",
      "",
      ...(this.title === undefined ? [] : [`- Title: ${this.redactor.redactText(this.title)}`]),
      `- Session ID: ${inlineCode(sessionId)}`,
      ...(this.model === undefined ? [] : [`- Model: ${inlineCode(this.model)}`]),
      `- Workspace: ${inlineCode(this.workspaceDir)}`,
    ].join("\n");
    return {
      markdown: `${header}${entries.length > 0 ? `\n\n${entries.join("\n\n")}` : ""}\n`,
      messageCount: entries.length,
    };
  }

  private renderEvent(event: AgentMessageEnvelope): string | undefined {
    const payload = event.payload;
    switch (payload.kind) {
      case "tool_called":
        return this.renderTool("Called", event, payload, payload.input);
      case "tool_output":
        return this.renderTool("Output", event, payload, payload.output);
      case "agent_spawned": {
        const agentName = payload.agentName?.trim() || payload.profileId || payload.agentType;
        return [
          `## Agent Spawned: ${heading(agentName)}`,
          "",
          `- Agent ID: ${inlineCode(event.agentId)}`,
          `- Agent Type: ${inlineCode(payload.agentType)}`,
          ...(payload.agentKey === undefined
            ? []
            : [`- Agent Key: ${inlineCode(payload.agentKey)}`]),
          ...(event.agentSessionId === undefined
            ? []
            : [`- Agent Session: ${inlineCode(event.agentSessionId)}`]),
          `- Profile: ${inlineCode(payload.profileId)}`,
          ...(event.taskId === undefined ? [] : [`- Task ID: ${inlineCode(event.taskId)}`]),
          ...(event.parentAgentId === undefined
            ? []
            : [`- Parent Agent: ${inlineCode(event.parentAgentId)}`]),
          `- Parent Session: ${inlineCode(event.sessionId)}`,
          ...(event.parentToolCallId === undefined
            ? []
            : [`- Parent Tool Call: ${inlineCode(event.parentToolCallId)}`]),
          ...(payload.prompt === undefined
            ? []
            : ["", "### Task", "", this.redactor.redactText(payload.prompt)]),
        ].join("\n");
      }
      case "agent_output":
        return [
          `## Agent Output: ${heading(payload.agentName?.trim() || event.agentId)}`,
          "",
          this.redactor.redactText(payload.text),
        ].join("\n");
      case "agent_finished":
        return [
          `## Agent Finished: ${heading(payload.agentName?.trim() || event.agentId)}`,
          "",
          `- Agent ID: ${inlineCode(event.agentId)}`,
          `- Status: ${inlineCode(payload.status)}`,
          ...(event.agentSessionId === undefined
            ? []
            : [`- Agent Session: ${inlineCode(event.agentSessionId)}`]),
          ...(event.taskId === undefined ? [] : [`- Task ID: ${inlineCode(event.taskId)}`]),
          ...(payload.error === undefined
            ? []
            : [`- Error: ${this.redactor.redactText(singleLine(payload.error))}`]),
        ].join("\n");
      case "checkpoint":
        return [
          `## Checkpoint: ${heading(payload.action)}`,
          "",
          `- Checkpoint ID: ${inlineCode(payload.checkpointId)}`,
          `- Agent ID: ${inlineCode(event.agentId)}`,
        ].join("\n");
      case "usage":
        return renderUsage(payload.model, payload.usage, event.agentId);
      case "session_lifecycle":
        return this.renderSessionLifecycle(payload);
      case "assistant_delta":
      case "hook_decision":
      case "memory_operation":
      case "reasoning":
      case "runtime_boundary_changed":
        return undefined;
    }
  }

  private renderSessionLifecycle(
    payload: Extract<AgentMessagePayload, { readonly kind: "session_lifecycle" }>,
  ): string | undefined {
    if (payload.phase !== "session_started" || !isRecord(payload.values)) {
      return undefined;
    }
    const prompt = payload.values.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return undefined;
    }
    return ["## User", "", this.redactor.redactText(prompt)].join("\n");
  }

  private renderTool(
    phase: "Called" | "Output",
    event: AgentMessageEnvelope,
    payload: Extract<AgentMessagePayload, { readonly kind: "tool_called" | "tool_output" }>,
    structuredValue: unknown,
  ): string {
    const details = [
      `- Agent ID: ${inlineCode(event.agentId)}`,
      `- Tool: ${inlineCode(payload.toolName)}`,
      `- Summary: ${this.redactor.redactText(singleLine(payload.summary))}`,
      ...(event.toolCallId === undefined
        ? []
        : [`- Tool Call ID: ${inlineCode(event.toolCallId)}`]),
    ];
    if (structuredValue !== undefined) {
      details.push("", "```json", this.stringifyStructured(structuredValue), "```");
    }
    return [`## Tool ${phase}: ${heading(payload.title)}`, "", ...details].join("\n");
  }

  private stringifyStructured(value: unknown): string {
    const bounded = boundJsonValue(value, 0);
    const redacted = this.redactor.redactJson(bounded);
    const serialized = JSON.stringify(redacted, null, 2);
    if (serialized.length <= MAX_STRUCTURED_CHARS) {
      return serialized;
    }
    return `${serialized.slice(0, MAX_STRUCTURED_CHARS)}\n... [structured value truncated]`;
  }

  private async resolveFilePath(filePath: string | undefined, sessionId: string): Promise<string> {
    if (filePath === undefined) {
      const resolvedPath = resolve(this.exportsDir, `${sessionId}.md`);
      if (!isPathWithin(this.exportsDir, resolvedPath)) {
        throw new Error("Session ID cannot be used as an export file name.");
      }
      return resolvedPath;
    }

    if (!filePath.trim()) {
      throw new Error("Export path must not be empty.");
    }
    const resolvedPath = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(this.workspaceDir, filePath);
    if (!isPathWithin(this.workspaceDir, resolvedPath)) {
      throw new Error("Export path must stay within the workspace.");
    }
    await assertRealParentWithinWorkspace(this.workspaceDir, resolvedPath);
    return resolvedPath;
  }
}

function parseEventLog(content: string, sessionId: string): readonly AgentMessageEnvelope[] {
  const lines = content.split(/\r?\n/u);
  const events: AgentMessageEnvelope[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw lineError(index + 1, error instanceof Error ? error.message : String(error));
    }

    let event: AgentMessageEnvelope;
    try {
      event = parseEnvelope(value);
    } catch (error) {
      throw lineError(index + 1, error instanceof Error ? error.message : String(error));
    }
    if (event.sessionId !== sessionId) {
      throw lineError(index + 1, `expected Session ${sessionId}, received ${event.sessionId}.`);
    }
    events.push(event);
  }

  return Object.freeze(events);
}

function parseEnvelope(value: unknown): AgentMessageEnvelope {
  const envelope = requireRecord(value, "event envelope");
  requireString(envelope.agentId, "agentId");
  requireString(envelope.eventId, "eventId");
  requireString(envelope.occurredAt, "occurredAt");
  requireString(envelope.sessionId, "sessionId");
  for (const key of [
    "agentSessionId",
    "parentAgentId",
    "parentToolCallId",
    "taskId",
    "toolCallId",
  ] as const) {
    if (envelope[key] !== undefined) {
      requireString(envelope[key], key);
    }
  }

  const payload = requireRecord(envelope.payload, "payload");
  const kind = requireString(payload.kind, "payload.kind");
  switch (kind) {
    case "assistant_delta":
      requireString(payload.text, "payload.text", true);
      break;
    case "reasoning":
      break;
    case "memory_operation":
      requireString(payload.namespaceHash, "payload.namespaceHash");
      requireString(payload.operation, "payload.operation");
      requireString(payload.operationId, "payload.operationId");
      requireString(payload.phase, "payload.phase");
      requireString(payload.startedAt, "payload.startedAt");
      if (payload.endedAt !== undefined) {
        requireString(payload.endedAt, "payload.endedAt");
      }
      if (payload.code !== undefined) {
        requireString(payload.code, "payload.code");
      }
      break;
    case "tool_called":
      validateToolPayload(payload, "input");
      break;
    case "tool_output":
      validateToolPayload(payload, "output");
      break;
    case "agent_spawned":
      requireString(payload.agentType, "payload.agentType");
      requireString(payload.profileId, "payload.profileId");
      for (const key of ["agentKey", "agentName", "prompt"] as const) {
        if (payload[key] !== undefined) {
          requireString(payload[key], `payload.${key}`, key === "prompt");
        }
      }
      break;
    case "agent_output":
      requireString(payload.text, "payload.text", true);
      for (const key of ["agentName", "profileId"] as const) {
        if (payload[key] !== undefined) {
          requireString(payload[key], `payload.${key}`);
        }
      }
      break;
    case "agent_finished":
      if (!["cancelled", "failed", "succeeded"].includes(String(payload.status))) {
        throw new Error("payload.status is invalid.");
      }
      for (const key of ["agentName", "error", "profileId"] as const) {
        if (payload[key] !== undefined) {
          requireString(payload[key], `payload.${key}`, key === "error");
        }
      }
      break;
    case "session_lifecycle":
      requireString(payload.phase, "payload.phase");
      break;
    case "hook_decision":
      requireString(payload.action, "payload.action");
      requireString(payload.eventName, "payload.eventName");
      if (
        !Array.isArray(payload.reasons) ||
        !payload.reasons.every((item) => typeof item === "string")
      ) {
        throw new Error("payload.reasons must be an array of strings.");
      }
      break;
    case "usage":
      requireString(payload.model, "payload.model");
      validateUsage(payload.usage);
      break;
    case "checkpoint":
      if (payload.action !== "created" && payload.action !== "restored") {
        throw new Error("payload.action is invalid.");
      }
      requireString(payload.checkpointId, "payload.checkpointId");
      break;
    case "runtime_boundary_changed":
      requireString(payload.from, "payload.from");
      requireString(payload.reason, "payload.reason");
      requireString(payload.to, "payload.to");
      break;
    default:
      throw new Error(`payload.kind is unsupported: ${kind}.`);
  }

  return envelope as unknown as AgentMessageEnvelope;
}

function validateToolPayload(
  payload: Readonly<Record<string, unknown>>,
  structuredKey: "input" | "output",
): void {
  requireString(payload.summary, "payload.summary", true);
  requireString(payload.title, "payload.title");
  requireString(payload.toolName, "payload.toolName");
  if (payload[structuredKey] !== undefined) {
    requireJsonValue(payload[structuredKey], `payload.${structuredKey}`);
  }
}

function validateUsage(value: unknown): asserts value is AgentUsage {
  const usage = requireRecord(value, "payload.usage");
  for (const key of [
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "peakInputTokens",
    "totalTokens",
  ] as const) {
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0) {
      throw new Error(`payload.usage.${key} must be a non-negative number.`);
    }
  }
}

function requireJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      requireJsonValue(item, path);
    }
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      requireJsonValue(child, path);
    }
    return;
  }
  throw new Error(`${path} must be JSON-compatible.`);
}

function boundJsonValue(value: unknown, depth: number): JsonValue {
  if (depth >= MAX_STRUCTURED_DEPTH && value !== null && typeof value === "object") {
    return "[Maximum depth reached]";
  }
  if (typeof value === "string") {
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}... [${value.length - MAX_STRING_CHARS} more characters]`;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundJsonValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      bounded.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return bounded;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const bounded = Object.fromEntries(
      entries
        .slice(0, MAX_OBJECT_ENTRIES)
        .map(([key, child]) => [key, boundJsonValue(child, depth + 1)]),
    );
    if (entries.length > MAX_OBJECT_ENTRIES) {
      bounded["..."] = `[${entries.length - MAX_OBJECT_ENTRIES} more entries]`;
    }
    return bounded;
  }
  return String(value);
}

function renderUsage(model: string, usage: AgentUsage, agentId: string): string {
  return [
    `## Usage: ${heading(model)}`,
    "",
    `- Agent ID: ${inlineCode(agentId)}`,
    `- Input tokens: ${usage.inputTokens}`,
    `- Output tokens: ${usage.outputTokens}`,
    `- Cached input tokens: ${usage.cachedInputTokens}`,
    `- Peak input tokens: ${usage.peakInputTokens}`,
    `- Total tokens: ${usage.totalTokens}`,
  ].join("\n");
}

async function writeAtomicArtifact(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;

  try {
    await mkdir(directory, { mode: 0o755, recursive: true });
    file = await open(temporaryPath, "wx", 0o644);
    await file.writeFile(content, "utf8");
    await file.chmod(0o644);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o644);
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
  } catch (error) {
    await file?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertRealParentWithinWorkspace(
  workspaceDir: string,
  filePath: string,
): Promise<void> {
  const workspaceRealPath = await realpath(workspaceDir);
  const existingParent = await nearestExistingPath(dirname(filePath));
  const parentRealPath = await realpath(existingParent);
  if (parentRealPath !== workspaceRealPath && !isPathWithin(workspaceRealPath, parentRealPath)) {
    throw new Error("Export path must stay within the workspace.");
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve export parent directory: ${path}.`);
    }
    current = parent;
  }
}

function requireAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} path must be absolute.`);
  }
  return resolve(path);
}

function isPathWithin(directory: string, path: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function lineError(line: number, message: string): Error {
  return new Error(`Invalid Session event log at line ${line}: ${message}`);
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function heading(value: string): string {
  return singleLine(value).replaceAll("#", "\\#");
}

function inlineCode(value: string): string {
  return `\`${singleLine(value).replaceAll("`", "\\`")}\``;
}
