import { readFile } from "node:fs/promises";
import { bindQaAuthorization, inspectRun, type QaRunManifest } from "./run-store.js";
import { readQaEvidence, startQaRun } from "./supervisor.js";

const [command, root, input, ...extra] = process.argv.slice(2);
const commands = ["start", "inspect", "evidence", "record-authorization"];
if (!root || !input || !commands.includes(command ?? "") || (command === "record-authorization" ? extra.length !== 1 : extra.length !== 0)) throw new Error("QA_CLI_ARGUMENTS_INVALID");
let result: unknown;
if (command === "start") result = await startQaRun(root, JSON.parse(await readFile(input, "utf8")) as QaRunManifest);
else if (command === "inspect") result = await inspectRun(root, input);
else if (command === "record-authorization") {
  const run = await inspectRun(root, input);
  result = { ...await bindQaAuthorization(root, run.manifest, extra[0]!), authorizationVerified: false, dispatchAllowed: false };
} else result = await readQaEvidence(root, input);
process.stdout.write(`${JSON.stringify(result)}\n`);
