import { readFile } from "node:fs/promises";
import { inspectRun, type QaRunManifest } from "./run-store.js";
import { readQaEvidence, startQaRun } from "./supervisor.js";

const [command, root, input, ...extra] = process.argv.slice(2);
if (!root || !input || extra.length || !["start", "inspect", "evidence"].includes(command ?? "")) throw new Error("QA_CLI_ARGUMENTS_INVALID");
let result: unknown;
if (command === "start") result = await startQaRun(root, JSON.parse(await readFile(input, "utf8")) as QaRunManifest);
else if (command === "inspect") result = await inspectRun(root, input);
else result = await readQaEvidence(root, input);
process.stdout.write(`${JSON.stringify(result)}\n`);
