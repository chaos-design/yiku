import type { AtomicDefinition } from "./types.js";

export const FLOW_ATOMS = Object.freeze({
  sinkError: {
    key: "flow.sink-error",
    kind: "trace",
    label: "Sink Error",
    level: "runtime",
  },
  traceAppend: {
    key: "trace.append",
    kind: "trace",
    label: "Trace Append",
    level: "runtime",
  },
} as const satisfies Readonly<Record<string, AtomicDefinition>>);

export const FLOW_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze(
  Object.values(FLOW_ATOMS),
);
