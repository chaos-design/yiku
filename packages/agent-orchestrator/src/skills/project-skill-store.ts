import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { isAlreadyExistsError, isNotFoundError, syncDirectory } from "../filesystem.js";
import { parseSkillDraft, type SkillDraft, type SkillStore } from "./skill-creation.js";
import { parseSkillMarkdown } from "./skill-parser.js";
import type { SkillDescriptor } from "./skill-types.js";

export interface ProjectSkillStoreOptions {
  readonly workspaceDir: string;
  readonly writable?: boolean | undefined;
}

export interface UserSkillStoreOptions {
  readonly homeDir: string;
  readonly writable?: boolean | undefined;
}

interface SkillFileStoreOptions {
  readonly rootDir: string;
  readonly source: "project" | "user";
  readonly writable?: boolean | undefined;
}

class SkillFileStore implements SkillStore {
  public readonly source: "project" | "user";
  private readonly skillsDir: string;
  private readonly rootDir: string;
  private readonly writable: boolean;

  public constructor(options: SkillFileStoreOptions) {
    if (!isAbsolute(options.rootDir)) {
      throw new Error("Skill storage root must be absolute.");
    }
    this.rootDir = resolve(options.rootDir);
    this.skillsDir = join(this.rootDir, ".yiku", "skills");
    this.source = options.source;
    this.writable = options.writable ?? true;
  }

  public async save(input: SkillDraft): Promise<SkillDescriptor> {
    this.assertWritable();
    const draft = parseSkillDraft(input);
    const configuredPath = join(this.skillsDir, draft.name, "SKILL.md");
    const content = serializeSkill(draft);
    const parsed = parseSkillMarkdown(content, configuredPath, this.source);
    if (!parsed.ok) {
      throw new Error(`Generated Skill is invalid: ${parsed.diagnostic.message}`);
    }

    const skillsDir = await this.ensureSkillsDirectory();
    const skillDir = join(skillsDir, draft.name);
    try {
      await fs.mkdir(skillDir, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`Skill already exists: ${configuredPath}.`);
      }
      throw error;
    }

    const path = join(skillDir, "SKILL.md");
    const temporaryPath = join(skillDir, `.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(temporaryPath, "wx", 0o600);
      await file.writeFile(content);
      await file.sync();
      await file.close();
      file = undefined;
      await fs.link(temporaryPath, path);
      await syncDirectory(skillDir);
      await syncDirectory(skillsDir);
    } finally {
      await file?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      await fs.rmdir(skillDir).catch(() => undefined);
    }

    return Object.freeze({
      ...parsed.descriptor,
      path,
    });
  }

  private async ensureSkillsDirectory(): Promise<string> {
    await assertNoSymlinkSegments(this.rootDir, this.skillsDir);
    await fs.mkdir(this.skillsDir, { mode: 0o700, recursive: true });
    await assertNoSymlinkSegments(this.rootDir, this.skillsDir);
    const root = await fs.realpath(this.rootDir);
    const directory = await fs.realpath(this.skillsDir);
    assertInside(root, directory);
    return directory;
  }

  private assertWritable(): void {
    if (!this.writable) {
      throw new Error("Skills cannot be modified in read-only mode.");
    }
  }
}

export class ProjectSkillStore extends SkillFileStore {
  public constructor(options: ProjectSkillStoreOptions) {
    super({
      rootDir: options.workspaceDir,
      source: "project",
      ...(options.writable !== undefined ? { writable: options.writable } : {}),
    });
  }
}

export class UserSkillStore extends SkillFileStore {
  public constructor(options: UserSkillStoreOptions) {
    super({
      rootDir: options.homeDir,
      source: "user",
      ...(options.writable !== undefined ? { writable: options.writable } : {}),
    });
  }
}

function serializeSkill(draft: SkillDraft): string {
  const frontmatter = stringify(
    {
      agentTypes: ["code"],
      description: draft.description,
      mcp: [],
      name: draft.name,
      version: "0.0.0-local",
    },
    { lineWidth: 0 },
  ).trim();
  return ["---", frontmatter, "---", "", draft.instructions.trim(), ""].join("\n");
}

async function assertNoSymlinkSegments(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`Project Skill path cannot contain symbolic links: ${current}.`);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }
}

function assertInside(root: string, path: string): void {
  const boundary = relative(root, path);
  if (boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
    throw new Error("Skill path must stay inside its storage root.");
  }
}
