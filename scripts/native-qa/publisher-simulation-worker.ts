import { performQaPublisherSimulation, type QaPublisherSimulationSpec } from "./publisher-simulation.js";

const [root, runId] = process.argv.slice(2);
if (!root || !runId || process.argv.length !== 4) throw new Error("QA_SIMULATION_INPUT_INVALID");
let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  text += chunk;
  if (text.length > 16384) throw new Error("QA_SIMULATION_INPUT_INVALID");
}
let input: unknown;
try { input = JSON.parse(text); } catch { throw new Error("QA_SIMULATION_INPUT_INVALID"); }
await performQaPublisherSimulation(root, runId, input as QaPublisherSimulationSpec);
