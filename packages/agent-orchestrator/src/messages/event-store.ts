import { chmod, type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { AgentMessageEnvelope, AgentMessageSink } from "./types.js";

export interface AgentEventStoreOptions {
  readonly filePath: string;
}

export class AgentEventStore implements AgentMessageSink, AsyncDisposable {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: AgentEventStoreOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new Error("Agent event store file path must be absolute.");
    }
  }

  public publish(message: AgentMessageEnvelope): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Agent event store is closed."));
    }

    const line = `${JSON.stringify(message)}\n`;
    const append = async () => {
      const handle = await this.ensureHandle();
      await handle.writeFile(line, "utf8");
    };
    const result = this.queue.then(append, append);
    this.queue = result.catch(() => undefined);
    return result;
  }

  public close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closed = true;
      this.closePromise = this.closeHandleAfterQueue();
    }
    return this.closePromise;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async closeHandleAfterQueue(): Promise<void> {
    await this.queue;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
  }

  private async ensureHandle(): Promise<FileHandle> {
    if (this.handle !== undefined) {
      return this.handle;
    }

    await mkdir(dirname(this.options.filePath), { mode: 0o700, recursive: true });
    const handle = await open(this.options.filePath, "a", 0o600);
    try {
      await chmod(this.options.filePath, 0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    this.handle = handle;
    return handle;
  }
}
