// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowLayout } from "../../src/data/flow-layout.js";
import {
  FlowLayoutClient,
  type FlowLayoutWorkerRequest,
} from "../../src/data/flow-layout-client.js";

const LAYOUT: FlowLayout = {
  atoms: [],
  diagnostics: [],
  domains: [],
  edges: [],
  height: 500,
  metrics: {
    bends: 0,
    collisions: 0,
    crossings: 0,
    fallbackCount: 0,
    length: 0,
    overlap: 0,
    portDeviation: 0,
    proximity: 0,
  },
  width: 1_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FlowLayoutClient", () => {
  it("runs layout requests through a module worker when available", async () => {
    const requests: FlowLayoutWorkerRequest[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        private readonly listeners = new Map<string, (event: MessageEvent) => void>();

        public addEventListener(type: string, listener: (event: MessageEvent) => void): void {
          this.listeners.set(type, listener);
        }

        public postMessage(request: FlowLayoutWorkerRequest): void {
          requests.push(request);
          this.listeners.get("message")?.(
            new MessageEvent("message", {
              data: {
                id: request.id,
                layout: LAYOUT,
              },
            }),
          );
        }

        public terminate(): void {}
      },
    );

    const client = new FlowLayoutClient();

    await expect(client.layout([], [])).resolves.toEqual(LAYOUT);
    expect(requests).toEqual([
      {
        atoms: [],
        edges: [],
        id: 1,
      },
    ]);
  });
});
