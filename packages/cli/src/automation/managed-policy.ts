import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PermissionRequest } from "@yiku/agent-orchestrator";
import { canonicalJson, requireSafeHookPath, sha256 } from "@yiku/hooks";
import { invalidAutomationInput } from "./errors.js";

const MAX_MANAGED_POLICY_BYTES = 1024 * 1024;

export const MANAGED_CAPABILITIES = [
  "credential.use",
  "external.publish",
  "external.request",
  "mcp.invoke",
  "process.execute",
  "workspace.delete",
  "workspace.read",
  "workspace.write",
] as const;

export type ManagedCapability = (typeof MANAGED_CAPABILITIES)[number];

export interface ManagedCapabilityRule {
  readonly capability: ManagedCapability;
  readonly expiresAt?: string | undefined;
  readonly resource?: string | undefined;
  readonly workspaceId: string;
}

export interface ManagedPolicyDocument {
  readonly auditRetentionDays?: number | undefined;
  readonly denies: readonly ManagedCapabilityRule[];
  readonly grants: readonly ManagedCapabilityRule[];
  readonly schemaVersion: 1;
}

export interface ManagedPolicyAssessment {
  readonly capability?: ManagedCapability | undefined;
  readonly decision: "allow" | "ask" | "deny";
  readonly reason: string;
}

export class ManagedPolicy {
  public constructor(
    public readonly digest: string,
    public readonly document: ManagedPolicyDocument,
    public readonly filePath: string,
    public readonly workspaceId: string,
  ) {}

  public assess(request: PermissionRequest, now = new Date()): ManagedPolicyAssessment {
    if (
      request.capabilities.includes("process.execute") &&
      request.metadata?.commandTruncated === "true"
    ) {
      return {
        decision: "ask",
        reason: "Managed Policy cannot authorize a truncated process command.",
      };
    }
    if (request.capabilities.length === 0) {
      return {
        decision: "ask",
        reason: "Managed Policy cannot authorize a request without capabilities.",
      };
    }
    const mapped = request.capabilities.map(mapCapability);
    const unknown = request.capabilities.find((_, index) => mapped[index] === undefined);
    if (unknown !== undefined) {
      return {
        decision: "ask",
        reason: `Managed Policy does not recognize capability: ${unknown}.`,
      };
    }

    const capabilities = [...new Set(mapped as ManagedCapability[])];
    for (const capability of capabilities) {
      const resource = permissionResource(capability, request);
      if (this.matches(this.document.denies, capability, resource, now)) {
        return {
          capability,
          decision: "deny",
          reason: `Managed Policy explicitly denies ${capability}.`,
        };
      }
    }

    for (const capability of capabilities) {
      const resource = permissionResource(capability, request);
      if (!this.matches(this.document.grants, capability, resource, now)) {
        return {
          capability,
          decision: "ask",
          reason: `Managed Policy does not grant ${capability}.`,
        };
      }
    }

    return {
      decision: "allow",
      reason: "All requested capabilities are explicitly granted by Managed Policy.",
    };
  }

  public grantsWorkspaceWrite(now = new Date()): ManagedPolicyAssessment {
    const capability = "workspace.write";
    if (this.matches(this.document.denies, capability, undefined, now)) {
      return {
        capability,
        decision: "deny",
        reason: "Managed Policy explicitly denies workspace.write.",
      };
    }
    return this.matches(this.document.grants, capability, undefined, now)
      ? {
          capability,
          decision: "allow",
          reason: "Managed Policy grants workspace.write.",
        }
      : {
          capability,
          decision: "ask",
          reason: "Managed Policy does not grant workspace.write.",
        };
  }

  private matches(
    rules: readonly ManagedCapabilityRule[],
    capability: ManagedCapability,
    resource: string | undefined,
    now: Date,
  ): boolean {
    return rules.some(
      (rule) =>
        rule.capability === capability &&
        rule.workspaceId === this.workspaceId &&
        (rule.expiresAt === undefined || Date.parse(rule.expiresAt) > now.getTime()) &&
        (rule.resource === undefined || rule.resource === resource),
    );
  }
}

export interface LoadManagedPolicyOptions {
  readonly filePath: string;
  readonly workspaceDir: string;
}

export async function loadManagedPolicy(options: LoadManagedPolicyOptions): Promise<ManagedPolicy> {
  if (process.platform === "win32") {
    throw invalidAutomationInput(
      "Managed Policy is unavailable because Windows ACL verification is not implemented.",
    );
  }

  const filePath = resolve(options.filePath);
  const workspaceId = await canonicalPath(options.workspaceDir);
  const inspection = await safePolicyInspection(filePath, workspaceId);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  let source: string;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== inspection.device ||
      opened.ino !== inspection.inode ||
      opened.uid !== inspection.ownerId ||
      (opened.mode & 0o022) !== 0
    ) {
      throw invalidAutomationInput("Managed Policy changed during secure open.");
    }
    if (opened.size > MAX_MANAGED_POLICY_BYTES) {
      throw invalidAutomationInput(`Managed Policy exceeds ${MAX_MANAGED_POLICY_BYTES} bytes.`);
    }
    source = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidAutomationInput(`Unable to parse Managed Policy: ${filePath}.`);
  }
  const document = parseManagedPolicyDocument(value);
  return new ManagedPolicy(sha256(canonicalJson(document)), document, filePath, workspaceId);
}

export function parseManagedPolicyDocument(value: unknown): ManagedPolicyDocument {
  const document = requireRecord(value, "Managed Policy");
  assertOnlyKeys(
    document,
    ["auditRetentionDays", "denies", "grants", "schemaVersion"],
    "Managed Policy",
  );
  if (document.schemaVersion !== 1) {
    throw invalidAutomationInput("Managed Policy schemaVersion must be 1.");
  }
  const auditRetentionDays =
    document.auditRetentionDays === undefined
      ? undefined
      : requireRetentionDays(document.auditRetentionDays);
  const grants = parseRules(document.grants, "grants", true);
  const denies =
    document.denies === undefined
      ? Object.freeze([])
      : parseRules(document.denies, "denies", false);
  return Object.freeze({
    ...(auditRetentionDays === undefined ? {} : { auditRetentionDays }),
    denies,
    grants,
    schemaVersion: 1,
  });
}

function parseRules(
  value: unknown,
  path: string,
  requireScopedResource: boolean,
): readonly ManagedCapabilityRule[] {
  if (!Array.isArray(value)) {
    throw invalidAutomationInput(`Managed Policy ${path} must be an array.`);
  }
  return Object.freeze(
    value.map((item, index) => {
      const record = requireRecord(item, `${path}.${index}`);
      assertOnlyKeys(
        record,
        ["capability", "expiresAt", "resource", "workspaceId"],
        `${path}.${index}`,
      );
      const capability = requireCapability(record.capability, `${path}.${index}.capability`);
      const workspaceId = requireAbsolutePath(record.workspaceId, `${path}.${index}.workspaceId`);
      const resource =
        record.resource === undefined
          ? undefined
          : requireNonEmptyString(record.resource, `${path}.${index}.resource`);
      if (resource?.includes("*")) {
        throw invalidAutomationInput(`${path}.${index}.resource must not contain wildcards.`);
      }
      if (requireScopedResource && requiresResourceScope(capability) && resource === undefined) {
        throw invalidAutomationInput(`${path}.${index}.${capability} requires resource scope.`);
      }
      const expiresAt =
        record.expiresAt === undefined
          ? undefined
          : requireDate(record.expiresAt, `${path}.${index}.expiresAt`);
      return Object.freeze({
        capability,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(resource === undefined ? {} : { resource }),
        workspaceId,
      });
    }),
  );
}

async function safePolicyInspection(filePath: string, workspaceId: string) {
  let inspection: Awaited<ReturnType<typeof requireSafeHookPath>>;
  try {
    inspection = await requireSafeHookPath(filePath);
  } catch {
    throw invalidAutomationInput(`Managed Policy path is not trusted: ${filePath}.`);
  }
  if (isWithin(workspaceId, inspection.realPath)) {
    throw invalidAutomationInput("Managed Policy must not be stored inside the Workspace.");
  }
  await assertSafeParentDirectories(inspection.realPath);
  return inspection;
}

async function assertSafeParentDirectories(filePath: string): Promise<void> {
  let current = dirname(filePath);
  for (;;) {
    const inspection = await lstat(current);
    if (inspection.isSymbolicLink() || !inspection.isDirectory()) {
      throw invalidAutomationInput("Managed Policy parent path is not a trusted directory.");
    }
    if ((inspection.mode & 0o022) !== 0) {
      throw invalidAutomationInput(
        "Managed Policy parent directories must not be group- or world-writable.",
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function mapCapability(capability: string): ManagedCapability | undefined {
  if (capability === "credential.use" || capability.startsWith("credential.")) {
    return "credential.use";
  }
  if (capability === "external.mcp.invoke") {
    return "mcp.invoke";
  }
  if (capability === "network.connect") {
    return "external.request";
  }
  if (capability === "package.publish") {
    return "external.publish";
  }
  if (capability === "process.execute") {
    return "process.execute";
  }
  if (capability === "workspace.delete") {
    return "workspace.delete";
  }
  if (capability === "workspace.read") {
    return "workspace.read";
  }
  if (capability.startsWith("workspace.")) {
    return "workspace.write";
  }
  return undefined;
}

function permissionResource(
  capability: ManagedCapability,
  request: PermissionRequest,
): string | undefined {
  return requiresResourceScope(capability) || capability === "process.execute"
    ? request.subject.trim().replaceAll(/\s+/gu, " ")
    : undefined;
}

function requiresResourceScope(capability: ManagedCapability): boolean {
  return (
    capability === "credential.use" ||
    capability === "external.publish" ||
    capability === "external.request" ||
    capability === "mcp.invoke"
  );
}

function requireCapability(value: unknown, path: string): ManagedCapability {
  if (typeof value !== "string" || !MANAGED_CAPABILITIES.includes(value as ManagedCapability)) {
    throw invalidAutomationInput(`${path} is not a supported Managed Capability.`);
  }
  return value as ManagedCapability;
}

function requireAbsolutePath(value: unknown, path: string): string {
  const normalized = requireNonEmptyString(value, path);
  if (!isAbsolute(normalized) || resolve(normalized) !== normalized) {
    throw invalidAutomationInput(`${path} must be a normalized absolute path.`);
  }
  return normalized;
}

function requireDate(value: unknown, path: string): string {
  const text = requireNonEmptyString(value, path);
  if (!Number.isFinite(Date.parse(text))) {
    throw invalidAutomationInput(`${path} must be an ISO date.`);
  }
  return text;
}

function requireRetentionDays(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 30 || (value as number) > 365) {
    throw invalidAutomationInput(
      "Managed Policy auditRetentionDays must be an integer between 30 and 365.",
    );
  }
  return value as number;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidAutomationInput(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw invalidAutomationInput(`${path} contains unknown field: ${unknown}.`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidAutomationInput(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const boundary = relative(root, candidate);
  return boundary === "" || (!boundary.startsWith("..") && !isAbsolute(boundary));
}
