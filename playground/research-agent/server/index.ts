import { ApiServer } from "./api-server.js";

const port = Number(process.env.YIKU_RESEARCHER_API_PORT ?? 4328);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error("YIKU_RESEARCHER_API_PORT must be a valid port.");
}

const server = new ApiServer({ port });
const address = await server.start();

console.log(`Research Agent Playground API: http://${address.host}:${address.port}`);

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
