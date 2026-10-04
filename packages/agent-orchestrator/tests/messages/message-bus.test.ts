import { describe, expect, it, vi } from "vitest";
import { AgentMessageBus, type AgentMessageEnvelope } from "../../src/messages/index.js";

function envelope(agentId: string, text: string): AgentMessageEnvelope {
  return {
    agentId,
    eventId: `event-${agentId}-${text}`,
    occurredAt: "2026-08-10T00:00:00.000Z",
    payload: { kind: "assistant_delta", text },
    sessionId: "session-1",
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe("AgentMessageBus", () => {
  it("preserves publication order per agent", async () => {
    const firstSinkCall = deferred();
    const seen: string[] = [];
    const bus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async (message) => {
            if (message.payload.kind === "assistant_delta" && message.payload.text === "first") {
              await firstSinkCall.promise;
            }
            if (message.payload.kind === "assistant_delta") {
              seen.push(message.payload.text);
            }
          },
        },
      ],
    });

    const first = bus.publish(envelope("agent-1", "first"));
    const second = bus.publish(envelope("agent-1", "second"));
    await vi.waitFor(() => expect(seen).toEqual([]));
    firstSinkCall.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(seen).toEqual(["first", "second"]);
  });

  it("allows independent agents to publish concurrently", async () => {
    const releaseFirstAgent = deferred();
    const completed: string[] = [];
    const bus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async (message) => {
            if (message.agentId === "agent-1") {
              await releaseFirstAgent.promise;
            }
            completed.push(message.agentId);
          },
        },
      ],
    });

    const first = bus.publish(envelope("agent-1", "first"));
    const second = bus.publish(envelope("agent-2", "second"));

    await expect(second).resolves.toBeUndefined();
    expect(completed).toEqual(["agent-2"]);
    releaseFirstAgent.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  it("awaits required sinks in registration order", async () => {
    const releaseFirstSink = deferred();
    const calls: string[] = [];
    const bus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async () => {
            calls.push("first:start");
            await releaseFirstSink.promise;
            calls.push("first:end");
          },
        },
        {
          kind: "required",
          publish: async () => {
            calls.push("second");
          },
        },
      ],
    });

    const publication = bus.publish(envelope("agent-1", "message"));
    await vi.waitFor(() => expect(calls).toEqual(["first:start"]));
    releaseFirstSink.resolve();

    await expect(publication).resolves.toBeUndefined();
    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("rejects on required sink failure and skips later sinks", async () => {
    const laterRequiredSink = vi.fn();
    const optionalSink = vi.fn();
    const bus = new AgentMessageBus({
      sinks: [
        { kind: "required", publish: async () => undefined },
        {
          kind: "required",
          publish: async () => {
            throw new Error("persistence failed");
          },
        },
        { kind: "required", publish: laterRequiredSink },
        { kind: "optional", publish: optionalSink },
      ],
    });

    await expect(bus.publish(envelope("agent-1", "message"))).rejects.toThrow("persistence failed");
    expect(laterRequiredSink).not.toHaveBeenCalled();
    expect(optionalSink).not.toHaveBeenCalled();
  });

  it("settles optional sinks and reports failures without rejecting", async () => {
    const releaseSlowSink = deferred();
    const onOptionalSinkError = vi.fn();
    const failingSink = vi.fn(async () => {
      throw new Error("offline");
    });
    const bus = new AgentMessageBus({
      onOptionalSinkError,
      sinks: [
        {
          kind: "optional",
          publish: async () => {
            await releaseSlowSink.promise;
          },
        },
        { kind: "optional", publish: failingSink },
      ],
    });
    const message = envelope("agent-1", "message");

    const publication = bus.publish(message);
    await vi.waitFor(() => expect(failingSink).toHaveBeenCalledOnce());
    releaseSlowSink.resolve();

    await expect(publication).resolves.toBeUndefined();
    expect(onOptionalSinkError).toHaveBeenCalledOnce();
    expect(onOptionalSinkError).toHaveBeenCalledWith(expect.any(Error), message);
  });

  it("snapshots subscribers, invokes them concurrently, and unsubscribes idempotently", async () => {
    const requiredStarted = deferred();
    const releaseRequired = deferred();
    const releaseSlowListener = deferred();
    const slowListener = vi.fn(async () => {
      await releaseSlowListener.promise;
    });
    const fastListener = vi.fn();
    const bus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async () => {
            requiredStarted.resolve();
            await releaseRequired.promise;
          },
        },
      ],
    });
    const unsubscribeSlow = bus.subscribe(slowListener);
    const unsubscribeFast = bus.subscribe(fastListener);

    const publication = bus.publish(envelope("agent-1", "first"));
    await requiredStarted.promise;
    unsubscribeSlow();
    unsubscribeSlow();
    unsubscribeFast();
    releaseRequired.resolve();

    await vi.waitFor(() => {
      expect(slowListener).toHaveBeenCalledOnce();
      expect(fastListener).toHaveBeenCalledOnce();
    });
    releaseSlowListener.resolve();
    await expect(publication).resolves.toBeUndefined();

    await expect(bus.publish(envelope("agent-1", "second"))).resolves.toBeUndefined();
    expect(slowListener).toHaveBeenCalledOnce();
    expect(fastListener).toHaveBeenCalledOnce();
  });

  it("reports subscriber failures without affecting required sinks", async () => {
    const onOptionalSinkError = vi.fn();
    const requiredSink = vi.fn();
    const bus = new AgentMessageBus({
      onOptionalSinkError,
      sinks: [{ kind: "required", publish: requiredSink }],
    });
    const message = envelope("agent-1", "message");
    bus.subscribe(() => {
      throw new Error("listener failed");
    });

    await expect(bus.publish(message)).resolves.toBeUndefined();
    expect(requiredSink).toHaveBeenCalledWith(message);
    expect(onOptionalSinkError).toHaveBeenCalledWith(expect.any(Error), message);
    expect(onOptionalSinkError.mock.calls[0]?.[0]).toMatchObject({
      message: "listener failed",
    });
  });

  it("flushes one agent without waiting for independent agents", async () => {
    const releases = new Map([
      ["agent-1", deferred()],
      ["agent-2", deferred()],
    ]);
    const completed: string[] = [];
    const bus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async (message) => {
            await releases.get(message.agentId)?.promise;
            completed.push(message.agentId);
          },
        },
      ],
    });

    const first = bus.publish(envelope("agent-1", "first"));
    const second = bus.publish(envelope("agent-2", "second"));
    const firstFlush = bus.flush("agent-1");
    releases.get("agent-1")?.resolve();

    await expect(firstFlush).resolves.toBeUndefined();
    expect(completed).toEqual(["agent-1"]);
    releases.get("agent-2")?.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("flushes all active agent queues", async () => {
    const releases = new Map([
      ["agent-1", deferred()],
      ["agent-2", deferred()],
    ]);
    const bus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async (message) => {
            await releases.get(message.agentId)?.promise;
          },
        },
      ],
    });

    const first = bus.publish(envelope("agent-1", "first"));
    const second = bus.publish(envelope("agent-2", "second"));
    let flushed = false;
    const flush = bus.flush().then(() => {
      flushed = true;
    });
    releases.get("agent-1")?.resolve();
    await first;
    expect(flushed).toBe(false);
    releases.get("agent-2")?.resolve();

    await expect(Promise.all([first, second, flush])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(flushed).toBe(true);
  });
});
