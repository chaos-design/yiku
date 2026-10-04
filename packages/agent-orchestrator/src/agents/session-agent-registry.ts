import { randomUUID } from "node:crypto";
import type { SessionToolCheckpointStore } from "../runtime/session-tool-middleware.js";
import {
  parseSessionState,
  type SessionState,
  type SessionSubagentInstance,
  type SessionSubagentProfile,
} from "../session/session-state.js";
import { requireText } from "../validation.js";
import type { AgentProfileStore, ProjectAgentProfileInput } from "./project-agent-profile-store.js";

export type SessionAgentRegistryErrorCode =
  | "AGENT_INSTANCE_NOT_FOUND"
  | "AGENT_PROFILE_DUPLICATE"
  | "AGENT_PROFILE_IN_USE"
  | "AGENT_PROFILE_LIMIT"
  | "AGENT_PROFILE_NOT_FOUND";

export class SessionAgentRegistryError extends Error {
  public override readonly name = "SessionAgentRegistryError";

  public constructor(
    public readonly code: SessionAgentRegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CreateSubagentProfileInput = ProjectAgentProfileInput;

export interface SessionAgentRegistryOptions {
  readonly idGenerator?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly profileStore?: AgentProfileStore | undefined;
  readonly sessionId: string;
  readonly store: SessionToolCheckpointStore;
}

export class SessionAgentRegistry {
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: SessionAgentRegistryOptions) {
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public create(input: CreateSubagentProfileInput): Promise<SessionSubagentProfile> {
    return this.enqueue(async () => {
      const current = await this.options.store.load(this.options.sessionId);
      const name = input.name.trim();
      assertCanCreate(current, name);
      const normalizedInput = { ...input, name };
      const profile =
        this.options.profileStore === undefined
          ? ({
              ...normalizedInput,
              createdAt: this.now().toISOString(),
              id: this.idGenerator(),
              source: "session",
            } satisfies SessionSubagentProfile)
          : await this.options.profileStore.save(normalizedInput);
      try {
        await this.options.store.update(this.options.sessionId, current.revision, (state) =>
          parseSessionState({
            ...state,
            subagentProfiles: [...state.subagentProfiles, profile],
          }),
        );
      } catch (error) {
        await this.options.profileStore?.remove(profile).catch(() => undefined);
        throw error;
      }
      return profile;
    });
  }

  public async get(profileId: string): Promise<SessionSubagentProfile | undefined> {
    return (await this.options.store.load(this.options.sessionId)).subagentProfiles.find(
      (profile) => profile.id === profileId,
    );
  }

  public async instances(profileId?: string): Promise<readonly SessionSubagentInstance[]> {
    const instances = (await this.options.store.load(this.options.sessionId)).subagentInstances;
    return Object.freeze(
      instances.filter((instance) => profileId === undefined || instance.profileId === profileId),
    );
  }

  public async list(): Promise<readonly SessionSubagentProfile[]> {
    return (await this.options.store.load(this.options.sessionId)).subagentProfiles;
  }

  public remove(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.options.store.load(this.options.sessionId);
      const profile = requireProfile(current, profileId);
      assertNotRunning(current, profileId);
      if (profile.source !== "session") {
        await requireProfileStore(this.options.profileStore).remove(profile);
      }
      try {
        await this.options.store.update(this.options.sessionId, current.revision, (state) =>
          parseSessionState({
            ...state,
            subagentProfiles: state.subagentProfiles.filter(
              (candidate) => candidate.id !== profileId,
            ),
          }),
        );
      } catch (error) {
        if (profile.source !== "session") {
          await requireProfileStore(this.options.profileStore)
            .save(toProfileInput(profile))
            .catch(() => undefined);
        }
        throw error;
      }
    });
  }

  public syncProjectProfiles(): Promise<readonly SessionSubagentProfile[]> {
    return this.syncPersistedProfiles();
  }

  public syncPersistedProfiles(): Promise<readonly SessionSubagentProfile[]> {
    if (this.options.profileStore === undefined) {
      return this.list();
    }
    return this.enqueue(async () => {
      const persistedProfiles = await this.options.profileStore?.list();
      const current = await this.options.store.load(this.options.sessionId);
      const sessionProfiles = current.subagentProfiles.filter(
        (profile) => profile.source === "session",
      );
      const profiles = [...sessionProfiles, ...(persistedProfiles ?? [])];
      assertProfileCollection(profiles);
      await this.options.store.update(this.options.sessionId, current.revision, (state) =>
        parseSessionState({
          ...state,
          subagentProfiles: profiles,
        }),
      );
      return Object.freeze(profiles);
    });
  }

  public startInstance(profileId: string, taskId: string): Promise<SessionSubagentInstance> {
    return this.mutate((state) => {
      requireProfile(state, profileId);
      const normalizedTaskId = requireText(taskId, "Task ID");
      const instance = {
        agentId: this.idGenerator(),
        profileId,
        startedAt: this.now().toISOString(),
        status: "running" as const,
        taskId: normalizedTaskId,
      };
      return {
        result: instance,
        state: parseSessionState({
          ...state,
          subagentInstances: [...state.subagentInstances, instance],
        }),
      };
    });
  }

  public finishInstance(
    agentId: string,
    status: Exclude<SessionSubagentInstance["status"], "running">,
    error?: string,
  ): Promise<SessionSubagentInstance> {
    return this.mutate((state) => {
      const current = state.subagentInstances.find((instance) => instance.agentId === agentId);
      if (current === undefined) {
        throw new SessionAgentRegistryError(
          "AGENT_INSTANCE_NOT_FOUND",
          `Subagent Instance not found: ${agentId}.`,
        );
      }
      const completed = {
        ...current,
        endedAt: this.now().toISOString(),
        ...(error?.trim() ? { error: error.trim() } : {}),
        status,
      };
      return {
        result: completed,
        state: parseSessionState({
          ...state,
          subagentInstances: state.subagentInstances.map((instance) =>
            instance.agentId === agentId ? completed : instance,
          ),
        }),
      };
    });
  }

  private mutate<TResult>(
    update: (state: SessionState) => {
      readonly result: TResult;
      readonly state: SessionState;
    },
  ): Promise<TResult> {
    const operation = async () => {
      const current = await this.options.store.load(this.options.sessionId);
      let result: TResult | undefined;
      await this.options.store.update(this.options.sessionId, current.revision, (state) => {
        const updated = update(state);
        result = updated.result;
        return updated.state;
      });
      return result as TResult;
    };
    return this.enqueue(operation);
  }

  private enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function assertCanCreate(state: SessionState, name: string): void {
  if (
    state.subagentProfiles.some(
      (profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    throw new SessionAgentRegistryError(
      "AGENT_PROFILE_DUPLICATE",
      `Subagent Profile name already exists: ${name}.`,
    );
  }
  if (state.subagentProfiles.length >= 12) {
    throw new SessionAgentRegistryError(
      "AGENT_PROFILE_LIMIT",
      "A Session supports at most 12 Subagent Profiles.",
    );
  }
}

function assertNotRunning(state: SessionState, profileId: string): void {
  if (
    state.subagentInstances.some(
      (instance) => instance.profileId === profileId && instance.status === "running",
    )
  ) {
    throw new SessionAgentRegistryError(
      "AGENT_PROFILE_IN_USE",
      `Subagent Profile is in use: ${profileId}.`,
    );
  }
}

function assertProfileCollection(profiles: readonly SessionSubagentProfile[]): void {
  if (profiles.length > 12) {
    throw new SessionAgentRegistryError(
      "AGENT_PROFILE_LIMIT",
      "A Session supports at most 12 Subagent Profiles.",
    );
  }
  const names = new Set<string>();
  for (const profile of profiles) {
    const name = profile.name.toLocaleLowerCase();
    if (names.has(name)) {
      throw new SessionAgentRegistryError(
        "AGENT_PROFILE_DUPLICATE",
        `Subagent Profile name already exists: ${profile.name}.`,
      );
    }
    names.add(name);
  }
}

function toProfileInput(profile: SessionSubagentProfile): ProjectAgentProfileInput {
  const {
    configPath: _configPath,
    createdAt: _createdAt,
    id: _id,
    source: _source,
    ...input
  } = profile;
  return input;
}

function requireProfileStore(store: AgentProfileStore | undefined): AgentProfileStore {
  if (store === undefined) {
    throw new Error("Persistent Agent Profile Store is not configured.");
  }
  return store;
}

function requireProfile(state: SessionState, profileId: string): SessionSubagentProfile {
  const profile = state.subagentProfiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    throw new SessionAgentRegistryError(
      "AGENT_PROFILE_NOT_FOUND",
      `Subagent Profile not found: ${profileId}.`,
    );
  }
  return profile;
}
