import { homedir } from "node:os";
import { resolve } from "node:path";
import { ApiServer, resolveWebAssetsDir } from "@yiku/agent-observatory/server";

const startPort = Number(process.env.YIKU_WEB_PORT || 4317);
const MAX_PORT = 65535;
const state = { server: null };

async function startFrom(port) {
  for (let p = port; p <= MAX_PORT; p += 1) {
    const s = new ApiServer({
      homeDir: resolve(homedir()),
      port: p,
      staticDir: resolveWebAssetsDir(),
      workspaceDir: process.cwd(),
    });
    try {
      const addr = await s.start();
      state.server = s;
      return addr;
    } catch (err) {
      await s.close().catch(() => {});
      if (!(err && err.code === "EADDRINUSE")) throw err;
    }
  }
  throw new Error("no available port");
}

const addr = await startFrom(startPort);
console.log(`YIKU_WEB_READY http://${addr.host}:${addr.port}`);

const shutdown = async () => {
  await state.server?.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
