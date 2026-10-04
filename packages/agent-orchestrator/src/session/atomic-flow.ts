import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { AtomicFlowRun, AtomicJsonlSink, AtomicStudioSink } from "@yiku/atomic-flow";
import { YikuPaths } from "@yiku/config";

export interface CreateSessionAtomicFlowOptions {
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentType?: string | undefined;
  readonly atomicRunsDir?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly kind?: "agent" | "control" | undefined;
  readonly prompt: string;
  readonly runId?: string | undefined;
  readonly sessionId: string;
  readonly trace?: boolean | undefined;
  readonly workspaceDir: string;
}

export function createSessionAtomicFlow(options: CreateSessionAtomicFlowOptions): AtomicFlowRun {
  const endpoint = options.endpoint?.trim();
  const workspaceDir = resolve(options.workspaceDir);
  const atomicRunsDir = resolve(
    options.atomicRunsDir ?? new YikuPaths({ workspaceDir }).atomicRunsDir,
  );
  const runId = options.runId?.trim() || randomUUID();
  const storageKey = createHash("sha256").update(runId).digest("hex");
  const sinks = [
    new AtomicJsonlSink({
      filePath: join(atomicRunsDir, storageKey, "flow.jsonl"),
    }),
    ...(endpoint
      ? [
          new AtomicStudioSink({
            endpoint,
            project: {
              id: workspaceDir,
              name: basename(workspaceDir),
            },
            run: {
              ...(options.agentKey !== undefined ? { agentKey: options.agentKey } : {}),
              ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
              ...(options.agentType !== undefined ? { agentType: options.agentType } : {}),
              kind: options.kind ?? "agent",
              prompt: options.prompt,
              sessionId: options.sessionId,
            },
          }),
        ]
      : []),
  ];

  return new AtomicFlowRun({
    runId,
    sinks,
    trace: options.trace,
  });
}
