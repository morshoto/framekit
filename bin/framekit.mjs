#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packagedEntrypoint = fileURLToPath(new URL("../dist-package/apps/cli/src/main.js", import.meta.url));
const developmentEntrypoint = fileURLToPath(new URL("../apps/cli/src/main.ts", import.meta.url));
const packaged = existsSync(packagedEntrypoint);
const child = spawn(
  process.execPath,
  [...(packaged ? [] : ["--import", "tsx"]), packaged ? packagedEntrypoint : developmentEntrypoint, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.once("error", (error) => {
  process.stderr.write(`framekit failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
