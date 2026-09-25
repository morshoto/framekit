import type { AgentVideoRuntime, ContextRevision } from "@framekit/runtime";
import type { EditingSessionChangeSource } from "./headless-sessions.js";

export function createSessionChangeSource(
  runtime: Pick<AgentVideoRuntime, "changesSince" | "inspectProject">,
): EditingSessionChangeSource {
  return {
    changesSince: async (revision: ContextRevision) => {
      try {
        const change = await runtime.changesSince(revision);
        return { from: change.from, to: change.to };
      } catch (error) {
        if (!String(error).includes("REVISION_NOT_FOUND:")) throw error;
        const current = await runtime.inspectProject();
        return { from: revision, to: current.revision };
      }
    },
  };
}
