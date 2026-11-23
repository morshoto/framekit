import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { FileCanonicalRecoveryGuard } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { ScriptedNativeReceiver, simulatedMaterializationPublisher } from "./simulated-native-receiver.js";

const directory = await realpath(process.argv[2]);
const root = await realpath(process.env.FRAMEKIT_TEST_STATE_DIR ?? "");
const childPath = relative(root, directory);
if (process.env.FRAMEKIT_COMMIT_VALIDATION !== "1" || process.env.FRAMEKIT_EDITOR !== "fixture" || process.env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES !== "0" || !childPath || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
  throw new Error("SIMULATED_MCP_ISOLATION_REQUIRED");
}
const receiverPath = join(directory, "receiver.json");
let receiver: ScriptedNativeReceiver;
try { receiver = ScriptedNativeReceiver.restore(JSON.parse(await readFile(receiverPath, "utf8"))); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
}
const publisher = simulatedMaterializationPublisher(receiver);
const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({ projectId: "fixture-project", projectName: "Fixture", timelineId: "fixture-sequence", timelineName: "Main", clips: [], media: [] }));
const server = createMcpServer(runtime, {
  sessionDirectory: join(directory, "sessions"),
  materializationDirectory: join(directory, "materializations"),
  canonicalRecovery: new FileCanonicalRecoveryGuard(join(directory, "recovery.json")),
  sessionChangeSource: { changesSince: async revision => ({ from: revision, to: revision }) },
  sessionMaterializationPublisher: {
    async publish(request) {
      try { return await publisher.publish(request); }
      finally { await writeFile(receiverPath, JSON.stringify(receiver.snapshot())); }
    },
  },
});
const transport = new StdioServerTransport();
await server.connect(transport);
