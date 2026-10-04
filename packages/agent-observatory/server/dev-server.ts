import { fileURLToPath } from "node:url";
import { ApiServer } from "./api-server.js";

const workspaceDir =
  process.env.YIKU_WORKSPACE_DIR ?? fileURLToPath(new URL("../../..", import.meta.url));
const server = new ApiServer({
  port: Number(process.env.YIKU_STUDIO_API_PORT ?? 4318),
  workspaceDir,
});
const address = await server.start();

process.stdout.write(`Yiku Agent Observatory API: http://${address.host}:${address.port}\n`);

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
