import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isAlreadyExistsError, isNotFoundError, syncDirectory } from "../filesystem.js";
import { parseSkillMarkdown } from "./skill-parser.js";
import type { SkillRuntime } from "./skill-runtime.js";
import type { SkillDescriptor } from "./skill-types.js";
import type { SkillRegistry } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_CANDIDATES = 256;
const MAX_DIRECTORY_DEPTH = 16;
const MAX_FILES = 1_024;
const MAX_INSTALL_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const GITHUB_REPOSITORY_PATTERN =
  /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;

export interface SkillSourceCloneOptions {
  readonly signal?: AbortSignal | undefined;
}

export type SkillSourceCloner = (
  repositoryUrl: string,
  destination: string,
  options: SkillSourceCloneOptions,
) => Promise<void>;

export interface SkillInstallationServiceOptions {
  readonly cloneRepository?: SkillSourceCloner | undefined;
  readonly gitPath?: string | undefined;
  readonly homeDir: string;
  readonly registry: SkillRegistry;
  readonly runtime: SkillRuntime;
  readonly workspaceDir: string;
  readonly writable?: boolean | undefined;
}

export interface InstallSkillOptions {
  readonly reservedNames?: readonly string[] | undefined;
  readonly selector?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface SkillCandidate {
  readonly descriptor: SkillDescriptor;
  readonly directory: string;
  readonly relativeDirectory: string;
}

interface ResolvedSkillSource {
  readonly cleanup: () => Promise<void>;
  readonly root: string;
}

export class SkillInstallationService {
  private readonly cloneRepository: SkillSourceCloner;
  private readonly homeDir: string;
  private readonly skillsDir: string;
  private readonly workspaceDir: string;
  private readonly writable: boolean;

  public constructor(private readonly options: SkillInstallationServiceOptions) {
    if (!isAbsolute(options.homeDir) || !isAbsolute(options.workspaceDir)) {
      throw new Error("Skill installation Home and Workspace directories must be absolute.");
    }
    this.homeDir = resolve(options.homeDir);
    this.workspaceDir = resolve(options.workspaceDir);
    this.skillsDir = join(this.homeDir, ".yiku", "skills");
    this.writable = options.writable ?? true;
    this.cloneRepository =
      options.cloneRepository ?? createGitSourceCloner(options.gitPath ?? "git");
  }

  public async install(
    source: string,
    installOptions: InstallSkillOptions = {},
  ): Promise<SkillDescriptor> {
    this.assertWritable();
    const resolvedSource = await this.resolveSource(source, installOptions.signal);
    let installedPath: string | undefined;

    try {
      const candidates = await discoverCandidates(resolvedSource.root);
      const candidate = selectCandidate(candidates, installOptions.selector);
      this.assertInstallable(candidate.descriptor, installOptions.reservedNames ?? []);
      installedPath = await this.copySkillDirectory(candidate);
      const discovery = await this.options.runtime.discover();
      const descriptor = this.options.runtime.inspect(candidate.descriptor.name);
      if (
        descriptor === undefined ||
        descriptor.source !== "user" ||
        resolve(descriptor.path) !== resolve(installedPath)
      ) {
        const diagnostic = discovery.diagnostics.find((item) =>
          item.path.includes(candidate.descriptor.name),
        );
        throw new Error(
          diagnostic === undefined
            ? `Installed Skill was not discovered: ${candidate.descriptor.name}.`
            : `Installed Skill is invalid: ${diagnostic.message}`,
        );
      }

      this.register(descriptor, await fs.readFile(descriptor.path, "utf8"));
      return descriptor;
    } catch (error) {
      if (installedPath !== undefined) {
        await fs.rm(resolve(installedPath, ".."), { force: true, recursive: true });
        await this.options.runtime.discover().catch(() => undefined);
      }
      throw error;
    } finally {
      await resolvedSource.cleanup();
    }
  }

  private async resolveSource(
    source: string,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedSkillSource> {
    const normalized = source.trim();
    if (!normalized || normalized.includes("\0")) {
      throw new Error("Skill source must be a non-empty local path or GitHub repository.");
    }

    const localPath = resolveLocalSource(normalized, this.homeDir, this.workspaceDir);
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isDirectory()) {
        throw new Error(`Local Skill source must be a directory: ${localPath}.`);
      }
      return {
        cleanup: async () => undefined,
        root: await fs.realpath(localPath),
      };
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const repositoryUrl = githubRepositoryUrl(normalized);
    if (repositoryUrl === undefined) {
      throw new Error(
        `Skill source does not exist and is not a supported GitHub repository: ${normalized}.`,
      );
    }

    const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "yiku-skill-source-"));
    const repositoryRoot = join(temporaryRoot, "repository");
    try {
      await this.cloneRepository(repositoryUrl, repositoryRoot, {
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        cleanup: () => fs.rm(temporaryRoot, { force: true, recursive: true }),
        root: await fs.realpath(repositoryRoot),
      };
    } catch (error) {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
      throw error;
    }
  }

  private assertInstallable(descriptor: SkillDescriptor, reservedNames: readonly string[]): void {
    if (new Set(reservedNames.map((name) => name.trim())).has(descriptor.name)) {
      throw new Error(`Skill name is reserved: ${descriptor.name}.`);
    }

    const discovered = this.options.runtime.inspect(descriptor.name);
    if (discovered !== undefined && discovered.source !== "builtin") {
      throw new Error(`Skill already exists: ${descriptor.name}.`);
    }
    const registered = this.options.registry.get(descriptor.name);
    if (
      registered !== undefined &&
      (discovered === undefined || registered.path !== discovered.path)
    ) {
      throw new Error(`Skill already exists: ${descriptor.name}.`);
    }
    if (registered !== undefined && this.options.registry.replace === undefined) {
      throw new Error(`Skill registry cannot replace the existing Skill: ${descriptor.name}.`);
    }
  }

  private async copySkillDirectory(candidate: SkillCandidate): Promise<string> {
    await assertNoSymlinkSegments(this.homeDir, this.skillsDir);
    await fs.mkdir(this.skillsDir, { mode: 0o700, recursive: true });
    await fs.chmod(this.skillsDir, 0o700);
    await assertNoSymlinkSegments(this.homeDir, this.skillsDir);
    const canonicalSkillsDir = await fs.realpath(this.skillsDir);
    const targetDirectory = join(canonicalSkillsDir, candidate.descriptor.name);
    assertInside(canonicalSkillsDir, targetDirectory);

    try {
      await fs.lstat(targetDirectory);
      throw new Error(`Skill already exists: ${targetDirectory}.`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const temporaryDirectory = join(
      canonicalSkillsDir,
      `.${candidate.descriptor.name}-${randomUUID()}.tmp`,
    );
    await fs.mkdir(temporaryDirectory, { mode: 0o700 });
    try {
      await copyDirectory(candidate.directory, temporaryDirectory);
      const temporarySkillPath = join(temporaryDirectory, "SKILL.md");
      const parsed = parseSkillMarkdown(
        await fs.readFile(temporarySkillPath, "utf8"),
        temporarySkillPath,
        "user",
      );
      if (!parsed.ok) {
        throw new Error(`Installed Skill is invalid: ${parsed.diagnostic.message}`);
      }
      if (parsed.descriptor.name !== candidate.descriptor.name) {
        throw new Error("Installed Skill changed while it was being copied.");
      }
      await fs.rename(temporaryDirectory, targetDirectory);
      await fs.chmod(targetDirectory, 0o700);
      await syncDirectory(canonicalSkillsDir);
      return join(targetDirectory, "SKILL.md");
    } catch (error) {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
      if (isAlreadyExistsError(error)) {
        throw new Error(`Skill already exists: ${targetDirectory}.`);
      }
      throw error;
    }
  }

  private register(descriptor: SkillDescriptor, content: string): void {
    const skill = {
      description: descriptor.description,
      digest: descriptor.digest,
      hookFrontmatter: content,
      instructions: descriptor.instructions,
      name: descriptor.name,
      path: descriptor.path,
      source: descriptor.source,
    };
    if (this.options.registry.get(descriptor.name) === undefined) {
      this.options.registry.register(skill);
      return;
    }
    this.options.registry.replace?.call(this.options.registry, skill);
  }

  private assertWritable(): void {
    if (!this.writable) {
      throw new Error("Skills cannot be modified in read-only mode.");
    }
  }
}

function createGitSourceCloner(gitPath: string): SkillSourceCloner {
  return async (repositoryUrl, destination, options) => {
    try {
      await execFileAsync(
        gitPath,
        [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--no-tags",
          "--",
          repositoryUrl,
          destination,
        ],
        {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
          },
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          timeout: GIT_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new Error("Git is required to install Skills from GitHub.", { cause: error });
      }
      throw new Error(`Unable to clone Skill repository: ${commandError(error)}`, {
        cause: error,
      });
    }
  };
}

async function discoverCandidates(root: string): Promise<readonly SkillCandidate[]> {
  const candidates: SkillCandidate[] = [];
  const diagnostics: string[] = [];

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skillFile !== undefined) {
      const path = join(directory, skillFile.name);
      const parsed = parseSkillMarkdown(await fs.readFile(path, "utf8"), path, "user");
      if (parsed.ok) {
        candidates.push({
          descriptor: parsed.descriptor,
          directory,
          relativeDirectory: normalizeRelativePath(relative(root, directory)),
        });
        if (candidates.length > MAX_CANDIDATES) {
          throw new Error(`Skill source contains more than ${MAX_CANDIDATES} candidates.`);
        }
      } else {
        diagnostics.push(
          `${normalizeRelativePath(relative(root, path))}: ${parsed.diagnostic.message}`,
        );
      }
    }

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (
        !entry.isDirectory() ||
        IGNORED_DIRECTORIES.has(entry.name) ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      await visit(join(directory, entry.name), depth + 1);
    }
  };

  await visit(root, 0);
  if (candidates.length === 0) {
    throw new Error(
      diagnostics.length === 0
        ? "Skill source does not contain a SKILL.md."
        : `Skill source does not contain a valid SKILL.md: ${diagnostics[0]}`,
    );
  }
  return Object.freeze(candidates);
}

function selectCandidate(
  candidates: readonly SkillCandidate[],
  selector: string | undefined,
): SkillCandidate {
  const normalizedSelector = normalizeSelector(selector);
  if (normalizedSelector === undefined) {
    const rootCandidate = candidates.find((candidate) => candidate.relativeDirectory === "");
    if (rootCandidate !== undefined) {
      return rootCandidate;
    }
    if (candidates.length === 1) {
      return candidates[0] as SkillCandidate;
    }
    throw new Error(
      `Skill source contains multiple Skills. Select one: ${candidateSummary(candidates)}.`,
    );
  }

  const matches = candidates.filter((candidate) => {
    const relativeSkillPath = candidate.relativeDirectory
      ? `${candidate.relativeDirectory}/SKILL.md`
      : "SKILL.md";
    return (
      candidate.descriptor.name === normalizedSelector ||
      candidate.relativeDirectory === normalizedSelector ||
      relativeSkillPath === normalizedSelector
    );
  });
  if (matches.length === 0) {
    throw new Error(
      `Skill was not found in the source: ${normalizedSelector}. Available: ${candidateSummary(candidates)}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Skill selector is ambiguous: ${normalizedSelector}. Use a source-relative directory path.`,
    );
  }
  return matches[0] as SkillCandidate;
}

async function copyDirectory(sourceRoot: string, destinationRoot: string): Promise<void> {
  let fileCount = 0;
  let totalBytes = 0;

  const copyEntries = async (
    sourceDirectory: string,
    destinationDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new Error(`Skill directory depth exceeds ${MAX_DIRECTORY_DEPTH}.`);
    }
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") {
        continue;
      }
      const source = join(sourceDirectory, entry.name);
      const destination = join(destinationDirectory, entry.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill installation does not allow symbolic links: ${source}.`);
      }
      if (stat.isDirectory()) {
        await fs.mkdir(destination, { mode: 0o700 });
        await copyEntries(source, destination, depth + 1);
        await syncDirectory(destination);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Skill installation only supports regular files: ${source}.`);
      }

      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_FILES || totalBytes > MAX_INSTALL_BYTES) {
        throw new Error(
          `Skill exceeds the installation limit of ${MAX_FILES} files or ${MAX_INSTALL_BYTES} bytes.`,
        );
      }
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      await fs.chmod(destination, stat.mode & 0o111 ? 0o700 : 0o600);
      const file = await fs.open(destination, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  };

  await copyEntries(sourceRoot, destinationRoot, 0);
  await syncDirectory(destinationRoot);
}

async function assertNoSymlinkSegments(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`User Skill path cannot contain symbolic links: ${current}.`);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }
}

function resolveLocalSource(source: string, homeDir: string, workspaceDir: string): string {
  if (source === "~") {
    return homeDir;
  }
  if (source.startsWith("~/")) {
    return resolve(homeDir, source.slice(2));
  }
  return resolve(workspaceDir, source);
}

function githubRepositoryUrl(source: string): string | undefined {
  const match = GITHUB_REPOSITORY_PATTERN.exec(source);
  const owner = match?.[1];
  const repository = match?.[2];
  return owner === undefined || repository === undefined
    ? undefined
    : `https://github.com/${owner}/${repository}.git`;
}

function normalizeSelector(selector: string | undefined): string | undefined {
  const normalized = selector
    ?.trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  return normalized ? normalized : undefined;
}

function normalizeRelativePath(path: string): string {
  return path === "." ? "" : path.split(sep).join("/");
}

function candidateSummary(candidates: readonly SkillCandidate[]): string {
  return candidates
    .slice(0, 20)
    .map((candidate) =>
      candidate.relativeDirectory
        ? `${candidate.descriptor.name} (${candidate.relativeDirectory})`
        : candidate.descriptor.name,
    )
    .join(", ");
}

function assertInside(root: string, path: string): void {
  const boundary = relative(root, path);
  if (boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
    throw new Error("Skill path must stay inside its storage root.");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function commandError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String((error as { readonly stderr?: unknown }).stderr ?? "").trim();
    if (stderr) {
      return stderr;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
