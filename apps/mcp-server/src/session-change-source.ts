import type { AgentVideoRuntime, ContextRevision } from "@framekit/runtime";
import type { EditingSessionChangeSource } from "./headless-sessions.js";

export function createSessionChangeSource(
  runtime: Pick<AgentVideoRuntime, "changesSince">,
): EditingSessionChangeSource {
  return {
    changesSince: async (revision: ContextRevision) => {
      const change = await runtime.changesSince(revision);
      return { from: change.from, to: change.to };
    },
  };
}
