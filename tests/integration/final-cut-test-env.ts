/**
 * Build the environment for live Final Cut contract tests without allowing
 * commit validation to enable native UI automation.
 */
export function finalCutMcpEnvironment(overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...overrides })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const commitValidation = environment.FRAMEKIT_COMMIT_VALIDATION === "1";
  if (!commitValidation || !environment.FRAMEKIT_TEST_STATE_DIR) {
    throw new Error("TEST_ISOLATION_REQUIRED: run Final Cut MCP contract tests through the isolated test runner");
  }

  return {
    ...environment,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_FINAL_CUT_HEADLESS: commitValidation
      ? "1"
      : (environment.FRAMEKIT_FINAL_CUT_HEADLESS ?? "0"),
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: commitValidation
      ? "0"
      : (environment.FRAMEKIT_FINAL_CUT_NATIVE_WRITES ?? "1"),
  };
}
