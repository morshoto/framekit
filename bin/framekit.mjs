#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../apps/cli/src/main.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.once("error", (error) => {
  process.stderr.write(`framekit failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
