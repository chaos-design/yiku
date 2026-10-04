import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_HEALTH_TIMEOUT_MS = 300;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface WebRegistration {
  readonly endpoint: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly workspaceDir: string;
}

export interface WebRegistryOptions {
  readonly healthTimeoutMs?: number | undefined;
  readonly homeDir: string;
  readonly pid?: number | undefined;
  readonly processExists?: ((pid: number) => boolean) | undefined;
  readonly request?: typeof fetch | undefined;
}

export class WebRegistry {
  private readonly healthTimeoutMs: number;
  private readonly path: string;
  private readonly pid: number;
  private readonly processExists: (pid: number) => boolean;
  private readonly request: typeof fetch;

  public constructor(options: WebRegistryOptions) {
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.path = join(resolve(options.homeDir), ".yiku", "web.json");
    this.pid = options.pid ?? process.pid;
    this.processExists = options.processExists ?? isProcessAlive;
    this.request = options.request ?? fetch;
  }

  public async register(
    input: Omit<WebRegistration, "pid" | "startedAt">,
  ): Promise<WebRegistration> {
    const registration: WebRegistration = {
      endpoint: normalizeEndpoint(input.endpoint),
      pid: this.pid,
      startedAt: new Date().toISOString(),
      workspaceDir: resolve(input.workspaceDir),
    };
    const temporaryPath = `${this.path}.${this.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(registration, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
      return registration;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async discover(): Promise<string | undefined> {
    return (await this.find())?.endpoint;
  }

  public async find(): Promise<WebRegistration | undefined> {
    const registration = await this.read();
    if (registration === undefined) {
      return undefined;
    }
    if (!this.processExists(registration.pid)) {
      await this.removeIfOwnedBy(registration.pid);
      return undefined;
    }

    try {
      const response = await this.request(`${registration.endpoint}/api/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return response.ok ? registration : undefined;
    } catch {
      return undefined;
    }
  }

  public current(): Promise<WebRegistration | undefined> {
    return this.read();
  }

  public async unregister(): Promise<void> {
    await this.removeIfOwnedBy(this.pid);
  }

  public filePath(): string {
    return this.path;
  }

  public logFilePath(): string {
    return join(dirname(this.path), "web.log");
  }

  private async read(): Promise<WebRegistration | undefined> {
    try {
      return parseRegistration(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return undefined;
    }
  }

  private async removeIfOwnedBy(pid: number): Promise<void> {
    const current = await this.read();
    if (current?.pid === pid) {
      await rm(this.path, { force: true });
    }
  }
}

function parseRegistration(value: unknown): WebRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Web registration must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new Error("Web registration PID is invalid.");
  }
  if (typeof record.startedAt !== "string" || Number.isNaN(Date.parse(record.startedAt))) {
    throw new Error("Web registration timestamp is invalid.");
  }
  if (typeof record.workspaceDir !== "string" || !record.workspaceDir.trim()) {
    throw new Error("Web registration workspace is invalid.");
  }
  return {
    endpoint: normalizeEndpoint(record.endpoint),
    pid: record.pid as number,
    startedAt: record.startedAt,
    workspaceDir: resolve(record.workspaceDir),
  };
}

function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Web registration endpoint is invalid.");
  }
  const endpoint = new URL(value.trim());
  if (
    endpoint.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase()) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Web registration endpoint must be a loopback HTTP URL.");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/u, "");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
