import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { WorkspaceContext } from "@yiku/agent-code";
import type { HookDecision, HookSession } from "@yiku/hooks";
import { isNotFoundError } from "../filesystem.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export type WorktreeManagerErrorCode =
  | "GIT_COMMAND_FAILED"
  | "GIT_WORKTREE_UNAVAILABLE"
  | "WORKTREE_DIRTY"
  | "WORKTREE_HANDLE_INVALID"
  | "WORKTREE_HOOK_BLOCKED"
  | "WORKTREE_HOOK_DEFERRED"
  | "WORKTREE_METADATA_INVALID";

export class WorktreeManagerError extends Error {
  public override readonly name = "WorktreeManagerError";

  public constructor(
    public readonly code: WorktreeManagerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface WorktreeHandle {
  readonly baseRevision: string;
  readonly branchName?: string | undefined;
  readonly id: string;
  readonly path: string;
  readonly taskId: string;
}

export interface CreateWorktreeInput {
  readonly baseRevision?: string | undefined;
  readonly name?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly taskId: string;
}

export interface RemoveWorktreeOptions {
  readonly force?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface WorktreeChangeSet {
  readonly changedFiles: readonly string[];
  readonly patch: string;
}

export interface WorktreeHookContext {
  readonly permissionMode: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
}

export interface WorktreeManagerOptions {
  readonly gitPath?: string | undefined;
  readonly hookContext?: WorktreeHookContext | undefined;
  readonly hookSession?: HookSession | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly storageDir?: string | undefined;
  readonly workspaceDir: string;
}

export class WorktreeManager {
  private readonly gitPath: string;
  private readonly idGenerator: () => string;
  private readonly repositoryStorageDir: string;
  private readonly workspace: WorkspaceContext;

  public constructor(private readonly options: WorktreeManagerOptions) {
    this.workspace = new WorkspaceContext({ rootDir: options.workspaceDir });
    this.gitPath = options.gitPath ?? "git";
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.repositoryStorageDir = join(
      resolve(options.storageDir ?? join(homedir(), ".yiku", "worktrees")),
      this.workspace.workspaceId,
    );
  }

  public async create(input: CreateWorktreeInput): Promise<WorktreeHandle> {
    const taskId = requireText(input.taskId, "Task ID");
    await this.requireGitWorkspace(input.signal);
    const baseRevision = await this.resolveRevision(input.baseRevision, input.signal);
    await this.requireCleanWorkspace(input.signal);
    const name = await this.dispatchCreateHook(input.name);
    const id = normalizeId(this.idGenerator());
    const directoryName = `${slug(name ?? `task-${taskId}`)}-${id}`;
    await fs.mkdir(this.recordsDir, { recursive: true, mode: 0o700 });
    const storageRoot = await fs.realpath(this.repositoryStorageDir);
    const targetPath = resolve(storageRoot, directoryName);
    assertInside(storageRoot, targetPath);

    try {
      await this.runGit(
        ["-C", this.workspace.rootDir, "worktree", "add", "--detach", targetPath, baseRevision],
        input.signal,
      );
      const canonicalPath = await fs.realpath(targetPath);
      assertInside(storageRoot, canonicalPath);
      const handle = Object.freeze({
        baseRevision,
        id,
        path: canonicalPath,
        taskId,
      });
      await this.writeRecord(handle);
      return handle;
    } catch (error) {
      await this.runGit(
        ["-C", this.workspace.rootDir, "worktree", "remove", "--force", targetPath],
        undefined,
        true,
      ).catch(() => undefined);
      throw error;
    }
  }

  public async list(): Promise<readonly WorktreeHandle[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.recordsDir);
    } catch (error) {
      if (isNotFoundError(error)) {
        return Object.freeze([]);
      }
      throw error;
    }
    const handles = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .toSorted()
        .map((entry) => this.readRecord(join(this.recordsDir, entry))),
    );
    return Object.freeze(handles);
  }

  public async collectChanges(
    handle: WorktreeHandle,
    signal?: AbortSignal,
  ): Promise<WorktreeChangeSet> {
    const current = await this.requireHandle(handle);
    const status = await this.runGit(
      ["-C", current.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      signal,
    );
    const changedFiles = parsePorcelainPaths(status.stdout);
    const trackedPatch = await this.runGit(
      ["-C", current.path, "diff", "--binary", "--no-ext-diff", current.baseRevision, "--"],
      signal,
    );
    const untrackedPatches: string[] = [];
    for (const path of changedFiles.filter((path) => statusEntryIsUntracked(status.stdout, path))) {
      const diff = await this.runGit(
        ["-C", current.path, "diff", "--no-index", "--binary", "--", "/dev/null", path],
        signal,
        true,
      );
      if (diff.stdout) {
        untrackedPatches.push(diff.stdout);
      }
    }
    return Object.freeze({
      changedFiles: Object.freeze(changedFiles),
      patch: [trackedPatch.stdout, ...untrackedPatches].filter(Boolean).join("\n"),
    });
  }

  public async remove(handle: WorktreeHandle, options: RemoveWorktreeOptions = {}): Promise<void> {
    const current = await this.requireHandle(handle);
    const status = await this.runGit(
      ["-C", current.path, "status", "--porcelain=v1", "--untracked-files=all"],
      options.signal,
    );
    if (status.stdout.trim() && options.force !== true) {
      throw new WorktreeManagerError(
        "WORKTREE_DIRTY",
        `Worktree has uncollected changes: ${current.path}.`,
      );
    }
    await this.dispatchRemoveHook(current.path);
    await this.runGit(
      [
        "-C",
        this.workspace.rootDir,
        "worktree",
        "remove",
        ...(options.force === true ? ["--force"] : []),
        current.path,
      ],
      options.signal,
    );
    await fs.unlink(this.recordPath(current.id));
  }

  private get recordsDir(): string {
    return join(this.repositoryStorageDir, "records");
  }

  private async dispatchCreateHook(name: string | undefined): Promise<string | undefined> {
    const hookSession = this.options.hookSession;
    const context = this.options.hookContext;
    if (hookSession === undefined || context === undefined) {
      return name;
    }
    const decision = await hookSession.dispatch({
      cwd: this.workspace.rootDir,
      hook_event_name: "WorktreeCreate",
      ...(name !== undefined ? { name } : {}),
      permission_mode: context.permissionMode,
      session_id: context.sessionId,
      transcript_path: context.transcriptPath,
    });
    requireHookAllowed("WorktreeCreate", decision);
    if (decision.updatedInput === undefined) {
      return name;
    }
    const keys = Object.keys(decision.updatedInput);
    if (keys.some((key) => key !== "name")) {
      throw new WorktreeManagerError(
        "WORKTREE_METADATA_INVALID",
        "WorktreeCreate Hook may only update the name field.",
      );
    }
    const updatedName = decision.updatedInput.name;
    if (updatedName === undefined) {
      return name;
    }
    if (typeof updatedName !== "string") {
      throw new WorktreeManagerError(
        "WORKTREE_METADATA_INVALID",
        "WorktreeCreate Hook name must be a string.",
      );
    }
    return requireText(updatedName, "Worktree name");
  }

  private async dispatchRemoveHook(path: string): Promise<void> {
    const hookSession = this.options.hookSession;
    const context = this.options.hookContext;
    if (hookSession === undefined || context === undefined) {
      return;
    }
    const decision = await hookSession.dispatch({
      cwd: this.workspace.rootDir,
      hook_event_name: "WorktreeRemove",
      permission_mode: context.permissionMode,
      session_id: context.sessionId,
      transcript_path: context.transcriptPath,
      worktree_path: path,
    });
    requireHookAllowed("WorktreeRemove", decision);
  }

  private async readRecord(path: string): Promise<WorktreeHandle> {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(path, "utf8"));
    } catch (error) {
      throw new WorktreeManagerError(
        "WORKTREE_METADATA_INVALID",
        `Worktree metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseHandle(value);
  }

  private recordPath(id: string): string {
    return join(this.recordsDir, `${normalizeId(id)}.json`);
  }

  private async requireGitWorkspace(signal?: AbortSignal): Promise<void> {
    let result: GitResult;
    try {
      result = await this.runGit(
        ["-C", this.workspace.rootDir, "rev-parse", "--show-toplevel"],
        signal,
      );
    } catch {
      throw new WorktreeManagerError(
        "GIT_WORKTREE_UNAVAILABLE",
        "Workspace is not a Git worktree.",
      );
    }
    const topLevel = await fs.realpath(result.stdout.trim());
    if (topLevel !== this.workspace.rootDir) {
      throw new WorktreeManagerError(
        "GIT_WORKTREE_UNAVAILABLE",
        "Workspace root must match the Git worktree root.",
      );
    }
  }

  private async requireHandle(handle: WorktreeHandle): Promise<WorktreeHandle> {
    const persisted = await this.readRecord(this.recordPath(handle.id));
    if (
      persisted.path !== handle.path ||
      persisted.taskId !== handle.taskId ||
      persisted.baseRevision !== handle.baseRevision
    ) {
      throw new WorktreeManagerError(
        "WORKTREE_HANDLE_INVALID",
        `Worktree handle does not match persisted metadata: ${handle.id}.`,
      );
    }
    const storageRoot = await fs.realpath(this.repositoryStorageDir);
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(persisted.path);
    } catch {
      throw new WorktreeManagerError(
        "WORKTREE_HANDLE_INVALID",
        `Worktree path is missing or inaccessible: ${persisted.path}.`,
      );
    }
    assertInside(storageRoot, canonicalPath);
    if (canonicalPath !== persisted.path) {
      throw new WorktreeManagerError(
        "WORKTREE_HANDLE_INVALID",
        `Worktree path identity changed: ${persisted.path}.`,
      );
    }
    return persisted;
  }

  private async requireCleanWorkspace(signal?: AbortSignal): Promise<void> {
    const status = await this.runGit(
      ["-C", this.workspace.rootDir, "status", "--porcelain=v1", "--untracked-files=all"],
      signal,
    );
    if (status.stdout.trim()) {
      throw new WorktreeManagerError(
        "GIT_WORKTREE_UNAVAILABLE",
        "Workspace has uncommitted changes; Worktree isolation would not preserve its current state.",
      );
    }
  }

  private async resolveRevision(
    requestedRevision: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const revision =
      requestedRevision === undefined ? "HEAD" : requireGitRevision(requestedRevision);
    try {
      const result = await this.runGit(
        [
          "-C",
          this.workspace.rootDir,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${revision}^{commit}`,
        ],
        signal,
      );
      return requireText(result.stdout, "Base revision");
    } catch {
      throw new WorktreeManagerError(
        "GIT_WORKTREE_UNAVAILABLE",
        "Workspace requires a valid base commit for Worktree isolation.",
      );
    }
  }

  private async runGit(
    args: readonly string[],
    signal?: AbortSignal,
    allowFailure = false,
  ): Promise<GitResult> {
    try {
      const result = await execFileAsync(this.gitPath, [...args], {
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } catch (error) {
      const failure = error as Error & {
        readonly code?: unknown;
        readonly stderr?: string | undefined;
        readonly stdout?: string | undefined;
      };
      if (allowFailure && failure.code === 1) {
        return {
          stderr: failure.stderr ?? "",
          stdout: failure.stdout ?? "",
        };
      }
      throw new WorktreeManagerError(
        "GIT_COMMAND_FAILED",
        `Git command failed: ${failure.stderr?.trim() || failure.message}.`,
      );
    }
  }

  private async writeRecord(handle: WorktreeHandle): Promise<void> {
    const path = this.recordPath(handle.id);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(temporaryPath, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(handle, null, 2)}\n`);
      await file.sync();
      await file.close();
      file = undefined;
      await fs.rename(temporaryPath, path);
    } finally {
      await file?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

interface GitResult {
  readonly stderr: string;
  readonly stdout: string;
}

function assertInside(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new WorktreeManagerError(
      "WORKTREE_HANDLE_INVALID",
      "Worktree path must stay within managed storage.",
    );
  }
}

function requireGitRevision(value: string): string {
  const revision = requireText(value, "Base revision");
  if (revision.startsWith("-") || !/^[A-Za-z0-9._/-]+$/u.test(revision)) {
    throw new WorktreeManagerError(
      "WORKTREE_METADATA_INVALID",
      "Base revision contains unsupported characters.",
    );
  }
  return revision;
}

function normalizeId(id: string): string {
  const normalized = requireText(id, "Worktree ID");
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new WorktreeManagerError(
      "WORKTREE_METADATA_INVALID",
      "Worktree ID contains unsupported characters.",
    );
  }
  return normalized;
}

function parseHandle(value: unknown): WorktreeHandle {
  if (typeof value !== "object" || value === null) {
    throw new WorktreeManagerError(
      "WORKTREE_METADATA_INVALID",
      "Worktree metadata must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  const handle = {
    baseRevision: requireText(record.baseRevision, "Base revision"),
    id: normalizeId(requireText(record.id, "Worktree ID")),
    path: resolve(requireText(record.path, "Worktree path")),
    taskId: requireText(record.taskId, "Task ID"),
  };
  return Object.freeze(handle);
}

function parsePorcelainPaths(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) {
      paths.push(path);
    }
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return [...new Set(paths)].toSorted();
}

function requireHookAllowed(eventName: string, decision: HookDecision): void {
  if (decision.action === "defer") {
    throw new WorktreeManagerError(
      "WORKTREE_HOOK_DEFERRED",
      `${eventName} was deferred by Hook policy.`,
    );
  }
  if (decision.action === "block" || decision.action === "stop") {
    throw new WorktreeManagerError(
      "WORKTREE_HOOK_BLOCKED",
      `${eventName} was blocked by Hook policy: ${decision.reasons.join("; ") || "blocked"}.`,
    );
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorktreeManagerError(
      "WORKTREE_METADATA_INVALID",
      `${label} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "worktree";
}

function statusEntryIsUntracked(status: string, path: string): boolean {
  return status.split("\0").some((record) => record.startsWith(`?? ${path}`));
}
