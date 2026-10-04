import { describe, expect, it } from "vitest";
import { IngestionError, parseIngestEvent } from "../../server/ingestion.js";

describe("parseIngestEvent", () => {
  it("accepts a complete atomic ingestion body", () => {
    const body = ingestionBody();

    expect(parseIngestEvent(body)).toEqual(body);
    const hookBody = {
      ...body,
      event: {
        ...body.event,
        atom: {
          ...body.event.atom,
          key: "hook.execute",
          kind: "hook",
          label: "PreToolUse",
        },
        edge: {
          ...body.event.edge,
          toAtomKey: "hook.execute",
        },
      },
    };
    expect(parseIngestEvent(hookBody)).toEqual(hookBody);
  });

  it("rejects malformed atoms, timestamps, sequences, and edge targets", () => {
    const invalidBodies = [
      { ...ingestionBody(), event: { ...ingestionBody().event, sequence: 0 } },
      {
        ...ingestionBody(),
        event: { ...ingestionBody().event, occurredAt: "not-a-date" },
      },
      {
        ...ingestionBody(),
        event: {
          ...ingestionBody().event,
          atom: { ...ingestionBody().event.atom, kind: "unknown" },
        },
      },
      {
        ...ingestionBody(),
        event: {
          ...ingestionBody().event,
          edge: {
            fromAtomKey: "input.prompt",
            kind: "execution",
            toAtomKey: "different",
          },
        },
      },
    ];

    for (const body of invalidBodies) {
      expect(() => parseIngestEvent(body)).toThrow(IngestionError);
    }
  });

  it("bounds run and project identifiers", () => {
    expect(() =>
      parseIngestEvent({
        ...ingestionBody(),
        event: {
          ...ingestionBody().event,
          runId: "x".repeat(129),
        },
      }),
    ).toThrow("Run ID exceeds 128 characters.");
    expect(() =>
      parseIngestEvent({
        ...ingestionBody(),
        project: {
          name: "",
        },
      }),
    ).toThrow("Project name must be non-empty.");
    expect(() =>
      parseIngestEvent({
        ...ingestionBody(),
        run: {
          prompt: "x".repeat(4_097),
        },
      }),
    ).toThrow("Run prompt exceeds 4096 characters.");
  });
});

function ingestionBody() {
  return {
    event: {
      atom: {
        key: "run",
        kind: "input",
        label: "Run",
        level: "runtime",
      },
      edge: {
        fromAtomKey: "input.prompt",
        kind: "execution",
        toAtomKey: "run",
      },
      eventId: "event-1",
      instance: {
        id: "run-instance",
      },
      occurredAt: "2026-08-01T00:00:00.000Z",
      phase: "start",
      runId: "external-run",
      sequence: 1,
    },
    project: {
      id: "project-id",
      name: "Runtime Project",
    },
    run: {
      prompt: "Observe the CLI",
      sessionId: "session-1",
    },
  };
}
