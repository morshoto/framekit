import { readFile } from "node:fs/promises";
import { bindQaAuthorization, inspectRun, type QaRunManifest } from "./run-store.js";
import { readQaEvidence, resumeHeadlessQaRun, startQaRun } from "./supervisor.js";
import { readQaArtifactEvidence, verifyQaArtifact } from "./artifact-evidence.js";
import { inspectQaPublisherFromStore } from "./publisher-inspection.js";

const [command, root, input, ...extra] = process.argv.slice(2);
const commands = ["start", "inspect", "evidence", "record-authorization", "resume-headless", "verify-artifact", "artifact-evidence", "inspect-publisher-store"];
const expectsExtra = command === "record-authorization" || command === "verify-artifact" || command === "inspect-publisher-store";
const allowsOptionalArtifact = command === "start" || command === "resume-headless";
if (!root || !input || !commands.includes(command ?? "") || (expectsExtra ? extra.length !== 1 : allowsOptionalArtifact ? extra.length > 1 : extra.length !== 0)) throw new Error("QA_CLI_ARGUMENTS_INVALID");
let result: unknown;
if (command === "start") result = await startQaRun(root, JSON.parse(await readFile(input, "utf8")) as QaRunManifest, extra[0]);
else if (command === "inspect") result = await inspectRun(root, input);
else if (command === "resume-headless") result = await resumeHeadlessQaRun(root, input, extra[0]);
else if (command === "verify-artifact") result = await verifyQaArtifact(root, input, extra[0]!);
else if (command === "artifact-evidence") result = await readQaArtifactEvidence(root, input);
else if (command === "inspect-publisher-store") result = await inspectQaPublisherFromStore(root, input, extra[0]!);
else if (command === "record-authorization") {
  const run = await inspectRun(root, input);
  result = { ...await bindQaAuthorization(root, run.manifest, extra[0]!), authorizationVerified: false, dispatchAllowed: false };
} else result = await readQaEvidence(root, input);
process.stdout.write(`${JSON.stringify(result)}\n`);
