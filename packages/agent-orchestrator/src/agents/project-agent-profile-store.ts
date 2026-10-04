import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { isAlreadyExistsError, isNotFoundError, syncDirectory } from "../filesystem.js";
import { toAgentProfileName } from "../session/agent-profile.js";
import type { SessionSubagentProfile } from "../session/session-state.js";
import type { SkillRuntime } from "../skills/skill-runtime.js";

const profileFrontmatterSchema = z
  .object({
    accessMode: z.enum(["read-only", "read-write"]),
    agentType: z.string().trim().min(1).max(256),
    createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    createdBy: z.enum(["agent", "user"]),
    description: z.string().trim().min(1).max(500),
    invocationMode: z.enum(["manual", "proactive"]),
    modelKey: z.string().trim().min(1).max(256),
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    purpose: z.enum([
      "code-review",
      "test-generation",
      "code-research",
      "feature-implementation",
      "custom",
    ]),
    scopes: z.array(z.string().trim().min(1).max(512)).min(1).max(8),
    skills: z.array(z.string().trim().min(1).max(64)).max(24),
    triggerInstructions: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type ProjectAgentProfileInput = Omit<
  SessionSubagentProfile,
  "configPath" | "createdAt" | "id" | "source"
>;

export interface AgentProfileStore {
  list(): Promise<readonly SessionSubagentProfile[]>;
  remove(profile: SessionSubagentProfile): Promise<void>;
  save(input: ProjectAgentProfileInput): Promise<SessionSubagentProfile>;
}

export interface ProjectAgentProfileStoreOptions {
  readonly now?: (() => Date) | undefined;
  readonly skillRuntime: SkillRuntime;
  readonly writable?: boolean | undefined;
  readonly workspaceDir: string;
}

export interface UserAgentProfileStoreOptions {
  readonly homeDir: string;
  readonly now?: (() => Date) | undefined;
  readonly skillRuntime: SkillRuntime;
  readonly writable?: boolean | undefined;
}

interface AgentProfileFileStoreOptions {
  readonly now?: (() => Date) | undefined;
  readonly rootDir: string;
  readonly skillRuntime: SkillRuntime;
  readonly source: "project" | "user";
  readonly writable?: boolean | undefined;
}

class AgentProfileFileStore implements AgentProfileStore {
  private readonly agentsDir: string;
  private readonly now: () => Date;
  private readonly rootDir: string;
  private readonly skillRuntime: SkillRuntime;
  private readonly source: "project" | "user";
  private readonly writable: boolean;

  public constructor(options: AgentProfileFileStoreOptions) {
    if (!isAbsolute(options.rootDir)) {
      throw new Error("Agent Profile storage root must be absolute.");
    }
    this.rootDir = resolve(options.rootDir);
    this.agentsDir = join(this.rootDir, ".yiku", "agents");
    this.now = options.now ?? (() => new Date());
    this.skillRuntime = options.skillRuntime;
    this.source = options.source;
    this.writable = options.writable ?? true;
  }

  public async list(): Promise<readonly SessionSubagentProfile[]> {
    let entries: string[];
    try {
      await this.assertAgentsDirectory(false);
      entries = await fs.readdir(this.agentsDir);
    } catch (error) {
      if (isNotFoundError(error)) {
        return Object.freeze([]);
      }
      throw error;
    }

    const profiles: SessionSubagentProfile[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".md")).toSorted()) {
      profiles.push(await this.read(join(this.agentsDir, entry)));
    }
    return Object.freeze(profiles);
  }

  public async save(input: ProjectAgentProfileInput): Promise<SessionSubagentProfile> {
    this.assertWritable();
    const directory = await this.assertAgentsDirectory(true);
    const name = toAgentProfileName(input.name);
    if (name !== input.name) {
      throw new Error("Project Agent Profile name must use lowercase kebab-case.");
    }
    const createdAt = this.now().toISOString();
    const path = join(directory, `${name}.md`);
    const profile: SessionSubagentProfile = {
      ...input,
      configPath: path,
      createdAt,
      id: persistedProfileId(this.source, name),
      name,
      source: this.source,
    };
    const content = serializeProfile(profile);
    const temporaryPath = join(directory, `.${name}.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(temporaryPath, "wx", 0o600);
      await file.writeFile(content);
      await file.sync();
      await file.close();
      file = undefined;
      await fs.link(temporaryPath, path);
      await syncDirectory(directory);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`Agent Profile already exists: ${path}.`);
      }
      throw error;
    } finally {
      await file?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
    return Object.freeze(profile);
  }

  public async remove(profile: SessionSubagentProfile): Promise<void> {
    this.assertWritable();
    if (profile.source !== this.source || profile.configPath === undefined) {
      throw new Error(`Agent Profile is not ${this.source}-persisted: ${profile.id}.`);
    }
    const directory = await this.assertAgentsDirectory(false);
    const path = resolve(profile.configPath);
    assertInside(directory, path);
    if (path !== join(directory, `${profile.name}.md`)) {
      throw new Error("Agent Profile path does not match its name.");
    }
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error("Agent Profile symbolic links cannot be removed.");
    }
    await fs.unlink(path);
    await syncDirectory(directory);
  }

  private async read(path: string): Promise<SessionSubagentProfile> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Agent Profile must be a regular file: ${path}.`);
    }
    const canonicalPath = await fs.realpath(path);
    const directory = await this.assertAgentsDirectory(false);
    assertInside(directory, canonicalPath);
    try {
      const parsed = parseProfile(await fs.readFile(canonicalPath, "utf8"));
      if (canonicalPath !== join(directory, `${parsed.frontmatter.name}.md`)) {
        throw new Error("Agent Profile filename must match its name.");
      }
      return Object.freeze({
        accessMode: parsed.frontmatter.accessMode,
        agentType: parsed.frontmatter.agentType,
        configPath: canonicalPath,
        createdAt: parsed.frontmatter.createdAt,
        createdBy: parsed.frontmatter.createdBy,
        deliverable: parsed.deliverable,
        description: parsed.frontmatter.description,
        id: persistedProfileId(this.source, parsed.frontmatter.name),
        instructions: parsed.instructions,
        invocationMode: parsed.frontmatter.invocationMode,
        modelKey: parsed.frontmatter.modelKey,
        name: parsed.frontmatter.name,
        purpose: parsed.frontmatter.purpose,
        role: parsed.role,
        scopes: [...parsed.frontmatter.scopes],
        skillSnapshots: this.skillRuntime
          .snapshot(parsed.frontmatter.skills, parsed.frontmatter.agentType)
          .map((snapshot) => ({
            ...snapshot,
            agentTypes: [...snapshot.agentTypes],
            mcpTargets: [...snapshot.mcpTargets],
          })),
        source: this.source,
        ...(parsed.frontmatter.triggerInstructions !== undefined
          ? { triggerInstructions: parsed.frontmatter.triggerInstructions }
          : {}),
      });
    } catch (error) {
      throw new Error(
        `Invalid Agent Profile ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async assertAgentsDirectory(create: boolean): Promise<string> {
    await assertNoSymlinkSegments(this.rootDir, this.agentsDir);
    if (create) {
      await fs.mkdir(this.agentsDir, { mode: 0o700, recursive: true });
      await assertNoSymlinkSegments(this.rootDir, this.agentsDir);
    }
    const root = await fs.realpath(this.rootDir);
    const directory = await fs.realpath(this.agentsDir);
    assertInside(root, directory);
    return directory;
  }

  private assertWritable(): void {
    if (!this.writable) {
      throw new Error("Agent Profiles cannot be modified in read-only mode.");
    }
  }
}

export class ProjectAgentProfileStore extends AgentProfileFileStore {
  public constructor(options: ProjectAgentProfileStoreOptions) {
    super({
      ...(options.now !== undefined ? { now: options.now } : {}),
      rootDir: options.workspaceDir,
      skillRuntime: options.skillRuntime,
      source: "project",
      ...(options.writable !== undefined ? { writable: options.writable } : {}),
    });
  }
}

export class UserAgentProfileStore extends AgentProfileFileStore {
  public constructor(options: UserAgentProfileStoreOptions) {
    super({
      ...(options.now !== undefined ? { now: options.now } : {}),
      rootDir: options.homeDir,
      skillRuntime: options.skillRuntime,
      source: "user",
      ...(options.writable !== undefined ? { writable: options.writable } : {}),
    });
  }
}

interface ParsedProfile {
  readonly deliverable: string;
  readonly frontmatter: z.infer<typeof profileFrontmatterSchema>;
  readonly instructions: string;
  readonly role: string;
}

function parseProfile(content: string): ParsedProfile {
  if (!content.startsWith("---\n")) {
    throw new Error("Agent Profile frontmatter is required.");
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error("Agent Profile frontmatter is not closed.");
  }
  const frontmatter = profileFrontmatterSchema.parse(parse(content.slice(4, end)));
  const body = content.slice(end + 5);
  return {
    deliverable: readSection(body, "Deliverable"),
    frontmatter,
    instructions: readSection(body, "Instructions"),
    role: readSection(body, "Role"),
  };
}

function readSection(body: string, heading: string): string {
  const expression = new RegExp(
    `(?:^|\\n)# ${heading}\\n\\n([\\s\\S]*?)(?=\\n# [^\\n]+\\n|$)`,
    "u",
  );
  const value = expression.exec(body)?.[1]?.trim();
  if (!value) {
    throw new Error(`Agent Profile section is required: ${heading}.`);
  }
  return value;
}

function serializeProfile(profile: SessionSubagentProfile): string {
  const frontmatter = stringify(
    {
      accessMode: profile.accessMode,
      agentType: profile.agentType,
      createdAt: profile.createdAt,
      createdBy: profile.createdBy,
      description: profile.description,
      invocationMode: profile.invocationMode,
      modelKey: profile.modelKey,
      name: profile.name,
      purpose: profile.purpose,
      scopes: [...profile.scopes],
      skills: profile.skillSnapshots.map((skill) => skill.name),
      ...(profile.triggerInstructions !== undefined
        ? { triggerInstructions: profile.triggerInstructions }
        : {}),
    },
    { lineWidth: 0 },
  ).trim();
  return [
    "---",
    frontmatter,
    "---",
    "",
    "# Role",
    "",
    profile.role.trim(),
    "",
    "# Deliverable",
    "",
    profile.deliverable.trim(),
    "",
    "# Instructions",
    "",
    profile.instructions.trim(),
    "",
  ].join("\n");
}

function persistedProfileId(source: "project" | "user", name: string): string {
  return `${source}-agent-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

async function assertNoSymlinkSegments(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`Agent Profile path cannot contain symbolic links: ${current}.`);
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
    throw new Error("Agent Profile path must stay inside its storage root.");
  }
}
