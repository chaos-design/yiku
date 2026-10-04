import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
const researchServerEnvironment = await resolveResearchServerEnvironment();
const services = [
  {
    args: ["exec", "tsx", "watch", "server/index.ts"],
    env: researchServerEnvironment,
    name: "research server",
    port: 4328,
    probe: async () => {
      const value = await responseJson("http://127.0.0.1:4328/api/observatory");
      return typeof value?.available === "boolean" && typeof value.url === "string";
    },
  },
  {
    args: ["exec", "vite"],
    name: "research web",
    port: 4327,
    probe: () => responseIncludes("http://127.0.0.1:4327/", "Yiku Research Workspace"),
  },
  {
    args: ["--filter", "@yiku/agent-observatory", "dev:server"],
    name: "observatory server",
    port: 4318,
    probe: async () => {
      const value = await responseJson("http://127.0.0.1:4318/api/studio/manifest");
      return Array.isArray(value) && value.some((entry) => entry?.id === "yiku.agent-observatory");
    },
  },
  {
    args: ["--filter", "@yiku/agent-observatory", "dev:web"],
    name: "observatory web",
    port: 4317,
    probe: () => responseIncludes("http://127.0.0.1:4317/", "Yiku Agent Observatory"),
  },
];
const commands = [];
for (const service of services) {
  if (await service.probe()) {
    console.log(`Reusing ${service.name} on http://127.0.0.1:${service.port}`);
  } else if (await portAvailable(service.port)) {
    commands.push(service);
  } else {
    throw new Error(`Port ${service.port} is occupied by a non-${service.name} process.`);
  }
}

const children = commands.map(({ args, env, name }) => {
  const child = spawn(corepackCommand, ["pnpm", ...args], {
    env: env ?? process.env,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      const exitCode = code ?? 1;
      console.error(`${name} exited with code ${exitCode}`);
      shutdown(exitCode);
    }
  });
  return child;
});

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(code);
}

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());

async function resolveResearchServerEnvironment() {
  if (
    process.env.YIKU_RESEARCHER_DATA_FILE?.trim() ||
    !process.env.TRAE_SANDBOX_SBOX_ID ||
    process.env.TOOLHOST_SANDBOX_DISABLED === "true"
  ) {
    return process.env;
  }

  const directory = join(
    tmpdir(),
    `yiku-research-agent-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
  );
  const filePath = join(directory, "conversations.json");
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);

  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    const source = join(homedir(), ".yiku", "research-agent", "conversations.json");
    try {
      await copyFile(source, filePath);
    } catch (copyError) {
      if (!isMissingFile(copyError)) {
        throw copyError;
      }
    }
  }

  try {
    await chmod(filePath, 0o600);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  console.warn(`Using sandbox-compatible research data file: ${filePath}`);
  return {
    ...process.env,
    YIKU_RESEARCHER_DATA_FILE: filePath,
  };
}

async function responseJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

async function responseIncludes(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok && (await response.text()).includes(expected);
  } catch {
    return false;
  }
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
