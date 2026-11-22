import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

function isChild(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Build the environment for live Final Cut contract tests without allowing
 * commit validation to enable native UI automation.
 */
export function finalCutMcpEnvironment(overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...overrides })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  let isolated = false;
  try {
    const root = realpathSync(environment.FRAMEKIT_TEST_STATE_DIR ?? "");
    const state = realpathSync(environment.FRAMEKIT_STATE_DIR ?? "");
    const temporaryRoot = realpathSync(process.platform === "win32" ? tmpdir() : "/tmp");
    isolated = isChild(temporaryRoot, root) && isChild(root, state);
  } catch {
    isolated = false;
  }
  if (environment.FRAMEKIT_COMMIT_VALIDATION !== "1" || !isolated) {
    throw new Error("TEST_ISOLATION_REQUIRED: run Final Cut MCP contract tests through the isolated test runner");
  }

  return {
    ...environment,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
  };
}
