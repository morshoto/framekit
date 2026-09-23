#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

const backend = process.env.FRAMEKIT_SPEECH_BACKEND?.trim();
if (!backend) fail(78, "SPEECH_ANALYZER_SETUP_REQUIRED: set FRAMEKIT_SPEECH_BACKEND to one executable Whisper/VAD backend path");

try {
  await access(backend, constants.X_OK);
} catch {
  fail(78, `SPEECH_ANALYZER_SETUP_REQUIRED: speech backend is not executable: ${backend}`);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

let request;
try {
  request = JSON.parse(input);
} catch (error) {
  fail(65, `SPEECH_ANALYZER_REQUEST_INVALID: wrapper received invalid JSON: ${String(error)}`);
}

const child = spawn(backend, [], { stdio: ["pipe", "pipe", "pipe"] });
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));
child.once("error", (error) => {
  fail(78, `SPEECH_ANALYZER_SETUP_REQUIRED: speech backend could not start: ${String(error)}`);
});
child.stdin.end(JSON.stringify(request));

const exitCode = await new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
const diagnostic = stderr.length > 0 ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : "";
if (exitCode !== 0) fail(78, `SPEECH_ANALYZER_BACKEND_FAILED: backend exited with code ${exitCode}${diagnostic}`);

let result;
try {
  result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
} catch (error) {
  fail(65, `SPEECH_ANALYZER_BACKEND_INVALID_OUTPUT: backend returned invalid JSON: ${String(error)}`);
}
if (!result || typeof result !== "object" || Array.isArray(result)) {
  fail(65, "SPEECH_ANALYZER_BACKEND_INVALID_OUTPUT: backend must return one JSON object");
}
process.stdout.write(JSON.stringify(result));

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
