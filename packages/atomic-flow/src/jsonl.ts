import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FLOW_ATOMS } from "./atoms.js";
import { AtomicFlowError } from "./errors.js";
import type {
  AtomicFlowEvent,
  AtomicFlowSink,
  AtomicJsonlSinkOptions,
  AtomicSinkReceiptDraft,
  ReadAtomicEventsOptions,
} from "./types.js";

const TRACE_PHASES = new Set<AtomicFlowEvent["phase"]>(["end", "error", "skipped"]);

export class AtomicJsonlSink implements AtomicFlowSink {
  public readonly durable = true;
  public readonly id = "jsonl";
  private readonly filePath: string;
  private readonly includeReceipts: boolean;

  public constructor(options: AtomicJsonlSinkOptions) {
    if (!options.filePath.trim()) {
      throw new AtomicFlowError("ATOMIC_FLOW_JSONL_INVALID", "Atomic JSONL file path is required.");
    }
    this.filePath = options.filePath;
    this.includeReceipts = options.includeReceipts ?? true;
  }

  public async write(event: AtomicFlowEvent): Promise<AtomicSinkReceiptDraft | undefined> {
    if (event.internal === true && !this.includeReceipts) {
      return undefined;
    }

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      throw new AtomicFlowError(
        "ATOMIC_FLOW_SINK_FAILED",
        "Failed to append the atomic flow JSONL file.",
        { cause: error },
      );
    }

    if (event.internal === true || !TRACE_PHASES.has(event.phase)) {
      return undefined;
    }

    return {
      atom: FLOW_ATOMS.traceAppend,
      payload: {
        counts: {
          persistedSequence: event.sequence,
        },
      },
      phase: "end",
    };
  }
}

export async function readAtomicFlowEvents(
  filePath: string,
  options: ReadAtomicEventsOptions = {},
): Promise<readonly AtomicFlowEvent[]> {
  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw new AtomicFlowError(
      "ATOMIC_FLOW_JSONL_INVALID",
      "Failed to read the atomic flow JSONL file.",
      { cause: error },
    );
  }

  const hasCompleteFinalLine = content.endsWith("\n");
  const lines = content.split("\n");
  const events: AtomicFlowEvent[] = [];
  let previousSequence = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    let event: AtomicFlowEvent;
    try {
      event = JSON.parse(line) as AtomicFlowEvent;
    } catch (error) {
      const isTruncatedFinalLine = index === lines.length - 1 && !hasCompleteFinalLine;
      if (isTruncatedFinalLine) {
        break;
      }
      throw new AtomicFlowError(
        "ATOMIC_FLOW_JSONL_INVALID",
        `Atomic flow JSONL line ${index + 1} is invalid.`,
        { cause: error },
      );
    }

    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= previousSequence ||
      typeof event.runId !== "string"
    ) {
      throw new AtomicFlowError(
        "ATOMIC_FLOW_JSONL_INVALID",
        `Atomic flow JSONL line ${index + 1} has an invalid sequence.`,
      );
    }

    previousSequence = event.sequence;
    if (event.sequence > (options.afterSequence ?? 0)) {
      events.push(event);
    }
  }

  return events;
}
