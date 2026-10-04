import { chmod, type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { HookDecision, HookEventName } from "@yiku/hooks";

export type SessionTranscriptRole = "assistant" | "system" | "user";

export type SessionTranscriptEntry =
  | {
      readonly content: string;
      readonly kind: "message";
      readonly recordedAt: string;
      readonly role: SessionTranscriptRole;
      readonly sequence: number;
    }
  | {
      readonly action: HookDecision["action"];
      readonly eventName: HookEventName;
      readonly kind: "hook";
      readonly reasons: readonly string[];
      readonly recordedAt: string;
      readonly sequence: number;
    };

export interface SessionTranscriptOptions {
  readonly clock?: (() => Date) | undefined;
  readonly filePath: string;
}

export class SessionTranscript {
  private readonly clock: () => Date;
  private closed = false;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(private readonly options: SessionTranscriptOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new Error("Session transcript path must be absolute.");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  public recordMessage(role: SessionTranscriptRole, content: string): Promise<void> {
    return this.enqueue({
      content,
      kind: "message",
      recordedAt: this.clock().toISOString(),
      role,
      sequence: this.nextSequence(),
    });
  }

  public recordHook(eventName: HookEventName, decision: HookDecision): Promise<void> {
    return this.enqueue({
      action: decision.action,
      eventName,
      kind: "hook",
      reasons: decision.reasons,
      recordedAt: this.clock().toISOString(),
      sequence: this.nextSequence(),
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.queue;
    await this.handle?.close();
    this.handle = undefined;
  }

  private enqueue(entry: SessionTranscriptEntry): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Session transcript is closed."));
    }

    const write = async () => {
      const handle = await this.ensureHandle();
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    };
    const result = this.queue.then(write, write);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureHandle(): Promise<FileHandle> {
    if (this.handle !== undefined) {
      return this.handle;
    }

    await mkdir(dirname(this.options.filePath), { mode: 0o700, recursive: true });
    this.handle = await open(this.options.filePath, "a", 0o600);
    await chmod(this.options.filePath, 0o600);
    return this.handle;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}
