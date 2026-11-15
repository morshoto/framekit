import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";
import { FinalCutConnectionManager } from "@framekit/final-cut";
import { runMcp } from "../../apps/cli/src/main.js";

test("development MCP startup sends connection status to stderr before inheriting protocol stdout", async () => {
  const stderrChunks: string[] = [];
  const stderr = {
    write(chunk: string) {
      stderrChunks.push(chunk);
      return true;
    },
  };
  let spawnOptions: SpawnOptions | undefined;
  let connectionOutput: unknown;
  const status = { state: "ready" } as Awaited<ReturnType<FinalCutConnectionManager["getStatus"]>>;
  const spawnChild = ((
    _command: string,
    _args: string[],
    options?: SpawnOptions,
  ) => {
    spawnOptions = options;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as ChildProcess;
  }) as typeof import("node:child_process").spawn;

  await runMcp(["--editor", "final-cut-live", "--development"], {
    stderr,
    connectDevelopmentExtension: async (args, output) => {
      assert.deepEqual(args, ["finalcut", "--development", "--json"]);
      connectionOutput = output;
      output.write('{"state":"ready"}\n');
      return status;
    },
    spawnChild,
  });

  assert.equal(connectionOutput, stderr);
  assert.deepEqual(stderrChunks, ['{"state":"ready"}\n']);
  assert.equal(spawnOptions?.stdio, "inherit");
  assert.equal((spawnOptions?.env as NodeJS.ProcessEnv).FRAMEKIT_REQUIRE_BUILD_ALIGNMENT, "1");
});
