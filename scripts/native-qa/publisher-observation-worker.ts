import { performQaPublisherObservation } from "./publisher-observation.js";

const [root, runId, observationId] = process.argv.slice(2);
if (!root || !runId || !observationId || process.argv.length !== 5) throw new Error("QA_OBSERVATION_ARGUMENTS_INVALID");
let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  text += chunk;
  if (text.length > 8192) throw new Error("QA_OBSERVATION_INPUT_INVALID");
}
const input: unknown = JSON.parse(text);
if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join(",") !== "directory"
  || typeof (input as Record<string, unknown>).directory !== "string") throw new Error("QA_OBSERVATION_INPUT_INVALID");
await performQaPublisherObservation(root, runId, observationId, (input as { directory: string }).directory);
