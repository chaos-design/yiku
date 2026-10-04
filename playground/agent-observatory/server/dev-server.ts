import { fileURLToPath } from "node:url";
import { ApiServer } from "@yiku/agent-observatory/server";
import { workspaceServerPlugin } from "./workspace-plugin.js";

const workspaceDir =
  process.env.YIKU_WORKSPACE_DIR ?? fileURLToPath(new URL("../../..", import.meta.url));
const server = new ApiServer({
  plugins: [workspaceServerPlugin()],
  port: Number(process.env.YIKU_STUDIO_API_PORT ?? 4318),
  workspaceDir,
});
const address = await server.start();

console.log(`Yiku Agent Observatory Playground API: http://${address.host}:${address.port}`);

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
