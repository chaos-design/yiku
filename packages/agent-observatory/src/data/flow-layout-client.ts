import type { AtomLayout, EdgeLayout } from "./atom-layout.js";
import type { FlowLayout } from "./flow-layout.js";

export interface FlowLayoutWorkerRequest {
  readonly atoms: readonly AtomLayout[];
  readonly edges: readonly EdgeLayout[];
  readonly id: number;
}

export type FlowLayoutWorkerResponse =
  | {
      readonly id: number;
      readonly layout: FlowLayout;
    }
  | {
      readonly error: string;
      readonly id: number;
    };

interface PendingLayout {
  readonly reject: (error: Error) => void;
  readonly resolve: (layout: FlowLayout) => void;
}

let fallbackEngine:
  | Promise<{
      layout(atoms: readonly AtomLayout[], edges: readonly EdgeLayout[]): Promise<FlowLayout>;
    }>
  | undefined;

export class FlowLayoutClient {
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingLayout>();
  private worker: Worker | undefined;
  private workerUnavailable = false;

  public layout(atoms: readonly AtomLayout[], edges: readonly EdgeLayout[]): Promise<FlowLayout> {
    const worker = this.ensureWorker();
    if (worker === undefined) {
      return fallbackLayout(atoms, edges);
    }

    const id = this.nextRequestId + 1;
    this.nextRequestId = id;
    return new Promise<FlowLayout>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        worker.postMessage({ atoms, edges, id } satisfies FlowLayoutWorkerRequest);
      } catch (cause) {
        this.pending.delete(id);
        reject(toError(cause));
      }
    });
  }

  private readonly handleError = (event: ErrorEvent): void => {
    const error = new Error(event.message || "Flow layout worker failed.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = undefined;
    this.workerUnavailable = true;
  };

  private readonly handleMessage = (event: MessageEvent<FlowLayoutWorkerResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(response.id);
    if ("layout" in response) {
      pending.resolve(response.layout);
    } else {
      pending.reject(new Error(response.error));
    }
  };

  private ensureWorker(): Worker | undefined {
    if (this.worker !== undefined || this.workerUnavailable) {
      return this.worker;
    }
    if (typeof Worker === "undefined") {
      this.workerUnavailable = true;
      return undefined;
    }
    try {
      this.worker = new Worker(new URL("./flow-layout-worker.js", import.meta.url), {
        type: "module",
      });
      this.worker.addEventListener("error", this.handleError);
      this.worker.addEventListener("message", this.handleMessage);
      return this.worker;
    } catch {
      this.workerUnavailable = true;
      return undefined;
    }
  }
}

function fallbackLayout(
  atoms: readonly AtomLayout[],
  edges: readonly EdgeLayout[],
): Promise<FlowLayout> {
  fallbackEngine ??= import("./flow-layout.js").then(
    ({ FlowLayoutEngine }) => new FlowLayoutEngine(),
  );
  return fallbackEngine.then((engine) => engine.layout(atoms, edges));
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
