import { spawn } from "node:child_process";

const commands = [
  ["server", ["tsx", "watch", "server/dev-server.ts"]],
  ["web", ["vite"]],
];
const children = commands.map(([name, args]) => {
  const child = spawn("pnpm", ["exec", ...args], {
    env: process.env,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
});

function shutdown(code = 0) {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(code);
}

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
