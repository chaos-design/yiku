#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_WATCH_PACKAGE_PATHS,
  createWatchChangeReason,
  isRelevantWatchChange,
} from "./dev-watch-config.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliPackageDir = resolve(scriptDir, "..");
const repoRoot = resolve(cliPackageDir, "../..");
const cliBinPath = resolve(cliPackageDir, "bin/yiku.js");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cliArgs = normalizeCliArgs(process.argv.slice(2));
const cliCwd = process.env.INIT_CWD || process.cwd();
const watchDebounceMs = 150;

const packageWatchRoots = CLI_WATCH_PACKAGE_PATHS.map((packagePath) =>
  resolve(repoRoot, packagePath),
);

const watchers = [];
let buildProcess;
let cliProcess;
let restartTimer;
let hasStartedCli = false;
let isBuilding = false;
let hasQueuedRestart = false;
let isShuttingDown = false;

function normalizeCliArgs(argv) {
  let firstCliArgIndex = 0;

  while (argv[firstCliArgIndex] === "--") {
    firstCliArgIndex += 1;
  }

  return argv.slice(firstCliArgIndex);
}

function log(message) {
  process.stdout.write(`[yiku dev] ${message}\n`);
}

function spawnBuild() {
  return new Promise((resolveBuild) => {
    buildProcess = spawn(packageManager, ["--filter", "@yiku/cli", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    buildProcess.once("exit", (code) => {
      buildProcess = undefined;
      resolveBuild(code === 0);
    });

    buildProcess.once("error", (error) => {
      buildProcess = undefined;
      log(`failed to start build: ${error.message}`);
      resolveBuild(false);
    });
  });
}

function startCli() {
  if (hasStartedCli && process.stdout.isTTY) {
    process.stdout.write("\u001B[2J\u001B[H");
  }
  hasStartedCli = true;
  log("starting CLI from dist via packages/cli/bin/yiku.js");

  cliProcess = spawn(process.execPath, [cliBinPath, ...cliArgs], {
    cwd: cliCwd,
    env: process.env,
    stdio: "inherit",
  });

  cliProcess.once("exit", (code, signal) => {
    cliProcess = undefined;

    if (isShuttingDown || isBuilding) {
      return;
    }

    if (signal) {
      log(`CLI exited with signal ${signal}`);
      return;
    }

    if (code && code !== 0) {
      log(`CLI exited with code ${code}`);
    }
  });
}

function stopCli() {
  return new Promise((resolveStop) => {
    if (!cliProcess || cliProcess.exitCode !== null) {
      resolveStop();
      return;
    }

    const processToStop = cliProcess;
    const killTimeout = setTimeout(() => {
      processToStop.kill("SIGKILL");
    }, 3000);

    processToStop.once("exit", () => {
      clearTimeout(killTimeout);
      resolveStop();
    });

    processToStop.kill("SIGTERM");
  });
}

async function rebuildAndRestart(reason) {
  if (isBuilding) {
    hasQueuedRestart = true;
    return;
  }

  isBuilding = true;
  hasQueuedRestart = false;
  await stopCli();

  if (isShuttingDown) {
    return;
  }

  log(`building dist${reason ? ` after ${reason}` : ""}`);
  const buildSucceeded = await spawnBuild();
  isBuilding = false;

  if (isShuttingDown) {
    return;
  }

  if (buildSucceeded) {
    startCli();
  } else {
    log("build failed; waiting for the next source change");
  }

  if (hasQueuedRestart) {
    scheduleRestart("queued source change");
  }
}

function scheduleRestart(reason) {
  if (isShuttingDown) {
    return;
  }

  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void rebuildAndRestart(reason);
  }, watchDebounceMs);
}

function watchPackageRoot(rootPath) {
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    log(`skipping missing watch root: ${relative(repoRoot, rootPath)}`);
    return;
  }

  const watcher = watch(rootPath, { recursive: true }, (_eventType, fileName) => {
    if (!isRelevantWatchChange(fileName)) {
      return;
    }

    scheduleRestart(createWatchChangeReason(repoRoot, rootPath, fileName));
  });

  watchers.push(watcher);
  log(`watching ${relative(repoRoot, rootPath)}`);
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  clearTimeout(restartTimer);

  for (const watcher of watchers) {
    watcher.close();
  }

  if (buildProcess && buildProcess.exitCode === null) {
    buildProcess.kill(signal);
  }

  await stopCli();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

for (const rootPath of packageWatchRoots) {
  watchPackageRoot(rootPath);
}

await rebuildAndRestart("initial start");
