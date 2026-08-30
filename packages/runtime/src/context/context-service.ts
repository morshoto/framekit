import type { AgentContext, ContextDiff, EditorChange, EditorLiveState } from "../domain/context.js";
import type { ContextRevision } from "../domain/primitives.js";
import type { EditorPort, LiveEditorStatePort } from "../domain/ports.js";
import type { RuntimeCapabilities } from "../domain/capabilities.js";
import type { TimelineDiff } from "../domain/diff.js";
import { ContextEngine } from "./context-engine.js";

export class ContextService {
  public constructor(
    private readonly adapter: EditorPort,
    private readonly context: ContextEngine,
  ) {}

  public async inspectContext(capabilities: RuntimeCapabilities): Promise<AgentContext> {
    return this.context.inspectContext(capabilities);
  }

  public async inspectLiveEditor(): Promise<EditorLiveState> {
    return this.liveAdapter().readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    return this.liveAdapter().liveChangesSince(revision, waitMs);
  }

  public async changesSince(revision: ContextRevision): Promise<TimelineDiff> {
    return this.context.changesSince(revision);
  }

  public async contextChangesSince(revision: ContextRevision, waitMs = 0): Promise<ContextDiff> {
    return this.context.contextChangesSince(revision, waitMs);
  }

  private liveAdapter(): LiveEditorStatePort {
    const candidate = this.adapter as Partial<LiveEditorStatePort>;
    if (typeof candidate.readLiveState !== "function" || typeof candidate.liveChangesSince !== "function") {
      throw new Error("CAPABILITY_UNAVAILABLE: live Framekit editor state");
    }
    return candidate as LiveEditorStatePort;
  }
}
