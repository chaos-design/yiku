import { FlowLayoutEngine } from "./flow-layout.js";
import type { FlowLayoutWorkerRequest, FlowLayoutWorkerResponse } from "./flow-layout-client.js";

const engine = new FlowLayoutEngine();
const workerScope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<FlowLayoutWorkerRequest>) => void,
  ): void;
  postMessage(message: FlowLayoutWorkerResponse): void;
};

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  void engine
    .layout(request.atoms, request.edges)
    .then((layout) => {
      workerScope.postMessage({
        id: request.id,
        layout,
      });
    })
    .catch((cause: unknown) => {
      workerScope.postMessage({
        error: cause instanceof Error ? cause.message : String(cause),
        id: request.id,
      });
    });
});
