import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createInitialSessionState,
  DefaultSkillRegistry,
  discoverSkills,
  ExecutionPolicy,
  extractProjectPromptInstructions,
  type PromptSegment,
  type ResolvedRuntimeConfig,
  resolveAgentGraph,
  resolveAgentHookComponents,
  resolveRuntimeConfig,
  type SessionState,
  SessionStore,
  SkillRuntime,
} from "@yiku/agent-orchestrator";
import {
  type EnvVars,
  loadEnvFile,
  loadModelsConfig,
  type ModelsConfig,
  mergeEnv,
  WorkspaceStorageLocator,
  type WorkspaceStorageResolution,
  type YikuPaths,
} from "@yiku/config";
import type { HookComponentFrontmatter } from "@yiku/hooks";
import { WebRegistry } from "./web/web-registry.js";

export interface CliSessionBootstrapOptions {
  readonly cwd?: string | undefined;
  readonly env?: EnvVars | undefined;
  readonly homeDir?: string | undefined;
  readonly modelsConfig?: ModelsConfig | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
}

export interface CliSessionBootstrapResult {
  readonly cwd: string;
  readonly environment: EnvVars;
  readonly homeDir: string;
  readonly hookComponents: readonly HookComponentFrontmatter[];
  readonly runtimeConfig: ResolvedRuntimeConfig;
  readonly skillRegistry: DefaultSkillRegistry;
  readonly skillRuntime: SkillRuntime;
  readonly storage: WorkspaceStorageResolution;
  readonly paths: YikuPaths;
  readonly promptSegments: readonly PromptSegment[];
  readonly projectConfig: ModelsConfig;
  readonly userConfig: ModelsConfig;
}

export interface CliSessionStateOptions {
  readonly agentKey?: string | undefined;
  readonly continueSession?: boolean | undefined;
  readonly modelKey?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly resumeStartsEpoch?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionsDir?: string | undefined;
}

export interface CliSessionStateResult {
  readonly resumed: boolean;
  readonly sessionsDir: string;
  readonly state: SessionState;
  readonly store: SessionStore;
}

export class CliSessionBootstrap {
  private readonly read: (path: string) => Promise<string>;

  public constructor(private readonly options: CliSessionBootstrapOptions = {}) {
    this.read = options.readFile ?? ((path) => readFile(path, "utf8"));
  }

  public async load(): Promise<CliSessionBootstrapResult> {
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const homeDir = resolve(this.options.homeDir ?? homedir());
    const storage = await new WorkspaceStorageLocator({ homeDir, workspaceDir: cwd }).resolve();
    const paths = storage.paths;
    const projectConfig = loadModelsConfig({
      configPath: join(cwd, "config.yaml"),
    });
    const projectSources = extractProjectPromptInstructions({
      config: projectConfig,
      configPath: join(cwd, "config.yaml"),
      env: loadEnvFile({ cwd }),
      envPath: join(cwd, ".env"),
    });
    const environment = mergeEnv(
      process.env,
      projectSources.env,
      loadEnvFile({ filePath: paths.envFilePath }),
      this.options.env ?? {},
    );
    if (!environment.YIKU_ATOMIC_STUDIO_URL?.trim()) {
      const endpoint = await new WebRegistry({ homeDir }).discover();
      if (endpoint !== undefined) {
        environment.YIKU_ATOMIC_STUDIO_URL = endpoint;
      }
    }
    const userConfig = this.options.modelsConfig ?? loadModelsConfig({ homeDir });
    const runtimeConfig = resolveRuntimeConfig({
      projectConfig: projectSources.config,
      userConfig,
    });
    const skillRegistry = await this.loadSkills(cwd, runtimeConfig);
    const skillRuntime = new SkillRuntime({
      discovery: () =>
        discoverSkills({
          builtinShadowedBy: Object.keys(runtimeConfig.skills),
          homeDir,
          workspaceDir: cwd,
        }),
      isMcpTargetAllowed: (target) => isConfiguredMcpTarget(target, runtimeConfig),
    });
    await skillRuntime.discover();
    for (const skill of skillRuntime.list()) {
      if (skillRegistry.get(skill.name) !== undefined) {
        throw new Error(`Skill is both configured and discovered: ${skill.name}.`);
      }
      skillRegistry.register({
        description: skill.description,
        digest: skill.digest,
        instructions: skill.instructions,
        name: skill.name,
        path: skill.path,
        source: skill.source,
      });
    }
    const hookComponents = Object.freeze([
      ...resolveAgentHookComponents(resolveAgentGraph(runtimeConfig.modelsConfig)),
      ...skillRegistry.resolveHookComponents(),
    ]);

    return Object.freeze({
      cwd,
      environment: Object.freeze(environment),
      homeDir,
      hookComponents,
      paths,
      promptSegments: projectSources.segments,
      projectConfig,
      runtimeConfig,
      skillRegistry,
      skillRuntime,
      storage,
      userConfig,
    });
  }

  private async loadSkills(
    workspaceDir: string,
    runtimeConfig: ResolvedRuntimeConfig,
  ): Promise<DefaultSkillRegistry> {
    const registry = new DefaultSkillRegistry();

    for (const skill of Object.values(runtimeConfig.skills)) {
      if (skill.instructions === undefined) {
        registry.register({ name: skill.name, source: "project" });
        continue;
      }

      const path = resolveSkillPath(workspaceDir, skill.instructions);
      const content = await this.read(path);
      const instructions = stripFrontmatter(content);
      registry.register({
        digest: createHash("sha256").update(content).digest("hex"),
        hookFrontmatter: content,
        ...(instructions ? { instructions } : {}),
        name: skill.name,
        path,
        source: "project",
      });
    }

    return registry;
  }
}

export class CliSessionState {
  public constructor(
    private readonly bootstrap: CliSessionBootstrapResult,
    private readonly options: CliSessionStateOptions = {},
  ) {}

  public async open(): Promise<CliSessionStateResult> {
    const sessionsDir = resolve(this.options.sessionsDir ?? this.bootstrap.paths.sessionsDir);
    const store = new SessionStore({ sessionsDir });

    try {
      const resumed =
        this.options.resumeSessionId !== undefined || this.options.continueSession === true;
      let state = resumed ? await this.loadResumedState(store) : await this.createState(store);
      validateResumedState(state, this.bootstrap);
      await store.acquireLease(state.sessionId);

      if (
        resumed &&
        state.status !== "needs-review" &&
        state.pendingInput === undefined &&
        this.options.resumeStartsEpoch !== false
      ) {
        const policy = new ExecutionPolicy(this.bootstrap.runtimeConfig.budget);
        state = await store.update(state.sessionId, state.revision, (current) =>
          policy.startEpoch(current),
        );
      }

      return {
        resumed,
        sessionsDir,
        state,
        store,
      };
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  private async loadResumedState(store: SessionStore): Promise<SessionState> {
    if (this.options.resumeSessionId !== undefined) {
      return store.load(this.options.resumeSessionId);
    }

    const candidates = await store.listResumable(this.bootstrap.cwd);
    const state = candidates[0];
    if (state === undefined) {
      throw new Error("No unfinished Session exists in the current workspace.");
    }
    return state;
  }

  private async createState(store: SessionStore): Promise<SessionState> {
    const graph = resolveAgentGraph(this.bootstrap.runtimeConfig.modelsConfig);
    const agentKey =
      this.options.agentKey?.trim() ||
      this.bootstrap.environment.YIKU_AGENT?.trim() ||
      graph.defaultAgentKey ||
      "code";
    const modelKey =
      this.options.modelKey?.trim() ??
      graph.items.get(agentKey)?.modelKey ??
      this.bootstrap.environment.AI_MODEL?.trim() ??
      readDefaultModelKey(this.bootstrap.runtimeConfig.modelsConfig) ??
      this.bootstrap.environment.AI_MODEL_NAME?.trim() ??
      "unknown";
    const state = createInitialSessionState({
      agentKey,
      configFingerprint: configFingerprint(this.bootstrap.runtimeConfig),
      modelKey,
      now: new Date().toISOString(),
      sessionId: sanitizeSessionId(this.options.sessionId?.trim() || randomUUID()),
      workspaceDir: this.bootstrap.cwd,
    });
    return store.create(state);
  }
}

function resolveSkillPath(workspaceDir: string, configuredPath: string): string {
  const path = resolve(workspaceDir, configuredPath);
  const boundary = relative(workspaceDir, path);

  if (boundary.startsWith("..") || isAbsolute(boundary)) {
    throw new Error("Skill instruction path escapes the workspace.");
  }
  return path;
}

function stripFrontmatter(content: string): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return content.trim();
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return closingIndex === -1
    ? content.trim()
    : lines
        .slice(closingIndex + 1)
        .join("\n")
        .trim();
}

function validateResumedState(state: SessionState, bootstrap: CliSessionBootstrapResult): void {
  if (resolve(state.workspaceDir) !== bootstrap.cwd) {
    throw new Error("Session workspace does not match the current workspace.");
  }
  if (state.status === "completed" || state.status === "failed") {
    throw new Error(`Session cannot be resumed from status ${state.status}.`);
  }
  if (state.configFingerprint !== configFingerprint(bootstrap.runtimeConfig)) {
    throw new Error("Session configuration changed and requires a new Session.");
  }
}

function configFingerprint(config: ResolvedRuntimeConfig): string {
  return createHash("sha256").update(JSON.stringify(config.modelsConfig)).digest("hex");
}

function readDefaultModelKey(modelsConfig: ModelsConfig): string | undefined {
  const models = modelsConfig.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    return undefined;
  }
  const value = (models as Record<string, unknown>).default;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function isConfiguredMcpTarget(target: string, runtimeConfig: ResolvedRuntimeConfig): boolean {
  const [server, tool] = target.split("/", 2);
  if (!server || !tool) {
    return false;
  }
  const configured = runtimeConfig.mcpServers[server];
  if (configured === undefined) {
    return false;
  }
  return configured.tools.some(
    (allowed) =>
      allowed === "*" ||
      allowed === tool ||
      (allowed.endsWith("*") && tool.startsWith(allowed.slice(0, -1))),
  );
}
