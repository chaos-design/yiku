# Atomic Flow

`@yiku/atomic-flow` is Yiku's Run-level event protocol. It unifies Atom definitions, the Instance lifecycle, Sequence, Edge, Sink, JSONL, and deterministic Fold, but does not execute Agents or interpret domain results.

## Model

### Atom

```ts
interface AtomicDefinition {
  key: string;
  kind: AtomicKind;
  label: string;
  level: "deep" | "runtime";
}
```

- `key`: stable flow node identifier;
- `kind`: presentation and semantic classification;
- `label`: human-readable name;
- `level`: regular Runtime or Deep View.

The same Atom may execute multiple times within a single Run.

### Instance

```ts
interface AtomicInstance {
  id: string;
  iteration?: number;
  parentId?: string;
}
```

An Instance ID identifies one concrete execution. Repeated loops are expressed via `iteration`, and hierarchy via `parentId`.

### Event

```ts
interface AtomicFlowEvent {
  atom: AtomicDefinition;
  edge?: AtomicEdge;
  eventId: string;
  instance: AtomicInstance;
  internal?: boolean;
  occurredAt: string;
  payload?: AtomicPayloadSummary;
  phase: AtomicPhase;
  runId: string;
  sequence: number;
}
```

Phase:

```text
scheduled -> start -> delta* -> end
                           \-> error
scheduled -----------------> skipped
```

Not all producers must emit `scheduled` first. A Span typically starts with `start` and ends with `end` or `error`.

### Edge

Edge types:

- `execution`
- `data`
- `feedback`
- `persistence`

An Edge references at least the Source/Target Atom Keys, with optional `fromInstanceId` for precisely associating the source execution. Parent expresses hierarchy, Edge expresses flow relationships; the two cannot substitute for each other.

### Payload

Payload is a bounded summary:

```ts
interface AtomicPayloadSummary {
  code?: string;
  counts?: Record<string, number>;
  durationMs?: number;
  summary?: string;
  title?: string;
  values?: Record<string, AtomicValue>;
}
```

Do not write API Keys, full Prompts, unbounded Tool output, or arbitrary Provider Payloads.

## Creating a Run

```ts
import {
  AtomicFlowRun,
  AtomicJsonlSink,
} from "@yiku/atomic-flow";

const flow = new AtomicFlowRun({
  runId: "run-1",
  sinks: [
    new AtomicJsonlSink({
      filePath: "/absolute/path/to/flow.jsonl",
    }),
  ],
});

const turn = flow.start({
  atom: {
    key: "loop.turn",
    kind: "loop",
    label: "Loop Turn",
    level: "runtime",
  },
  iteration: 1,
});

turn.delta({ summary: "Calling model" });
turn.end({ summary: "Completed" });
await flow.close();
```

`AtomicSpan` retains the Instance ID. Producers should emit terminal state on the same instance, not regenerate an ID for End.

## Sequence and Dispatch

- Sequence strictly increases within a single Run;
- Events first enter the in-memory Buffer and Subscribers, then are written in each Sink's queue order;
- Different Sinks may advance in parallel, but a single Sink does not reorder;
- Subscriber exceptions cannot alter the originating Flow;
- `flush()` waits for the current Sink queues;
- `close()` flushes and then closes all Sinks;
- A closed Run rejects new events.

The Buffer is bounded by `maxBufferedEvents`. A Snapshot contains only the currently visible Buffer; the persistent JSONL can retain the full history.

## Sinks and Degradation

```ts
interface AtomicFlowSink {
  id: string;
  durable?: boolean;
  write(event): AtomicSinkReceiptDraft | void | Promise<...>;
  close?(): void | Promise<void>;
}
```

Sink failures do not stop the originating Run. Flow:

1. Record a degradation code;
2. `snapshot().degraded` becomes `true`;
3. Other Sinks continue receiving;
4. When `trace` is enabled, an internal `flow.sink-error` or Receipt is generated.

Internal Receipts no longer recursively produce Receipts.

## JSONL

`AtomicJsonlSink` appends events line by line. The path must be an absolute, valid file path; write failures are handled as Sink degradation.

```ts
import { readAtomicFlowEvents } from "@yiku/atomic-flow";

const events = await readAtomicFlowEvents("/absolute/path/to/flow.jsonl", {
  afterSequence: 100,
});
```

The Reader validates each line's JSON and the basic event structure. Corrupt lines return `ATOMIC_FLOW_JSONL_INVALID` and are not silently skipped.

## Fold

```ts
import { foldAtomicEvents } from "@yiku/atomic-flow";

const state = foldAtomicEvents(events);
```

Fold builds by Sequence:

- `instances`: each Instance's Atom, status, time, Iteration, and Parent;
- `edges`: observed flow relationships;
- `latestSequence`;
- `runId`.

State mapping:

| Phase | Status |
| --- | --- |
| `scheduled` | `scheduled` |
| `start` / `delta` | `running` |
| `end` | `completed` |
| `error` | `failed` |
| `skipped` | `skipped` |

Fold rejects Sequence regressions, mixed Runs, and inconsistent Instance definitions. The same canonical event prefix produces the same Fold state.

## Studio Delivery

```ts
import { AtomicFlowRun, AtomicStudioSink } from "@yiku/atomic-flow";

const flow = new AtomicFlowRun({
  runId: crypto.randomUUID(),
  sinks: [
    new AtomicStudioSink({
      endpoint: "http://127.0.0.1:3333",
      project: { id: "checkout", name: "Checkout" },
      run: {
        kind: "agent",
        prompt: "Review checkout",
        sessionId: "session-1",
      },
    }),
  ],
});
```

The Studio Sink accepts only loopback addresses. Project and Run metadata are established on the first successful delivery.

## Public Entry Points

- `AtomicFlowRun`
- `AtomicSpan`
- `AtomicJsonlSink`
- `AtomicStudioSink`
- `readAtomicFlowEvents`
- `foldAtomicEvents`
- `isTraceObservationEvent`
- Atom, Event, Edge, Sink, Snapshot, and Fold types

## Errors

| Code | Meaning |
| --- | --- |
| `ATOMIC_FLOW_CLOSED` | Run is closed |
| `ATOMIC_FLOW_INVALID_ATOM` | Invalid Atom definition |
| `ATOMIC_FLOW_INVALID_EVENT` | Invalid Event or Sequence |
| `ATOMIC_FLOW_INVALID_INSTANCE` | Invalid Instance lifecycle |
| `ATOMIC_FLOW_INVALID_RUN` | Invalid Run ID or metadata |
| `ATOMIC_FLOW_JSONL_INVALID` | Invalid JSONL path or content |
| `ATOMIC_FLOW_SINK_FAILED` | Sink write or delivery failure |

## Verification

```bash
corepack pnpm --filter @yiku/atomic-flow build
corepack pnpm --filter @yiku/atomic-flow test
```

All built-in Keys are documented in the [Atom Catalog](atom-catalog.md); for trajectory projection see [Trajectory](trajectory.md).
