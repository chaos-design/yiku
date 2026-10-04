#!/usr/bin/env node
const { runCliRuntime } = await import("../dist/index.js");

process.exitCode = await runCliRuntime();
