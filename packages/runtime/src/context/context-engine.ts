import { diffSnapshots } from "../diff/diff.js";
import type { ContextRevision, EditorPort, ProjectSnapshot, TimelineDiff } from "../domain/types.js";

export class ContextEngine {
  private readonly snapshots = new Map<string, ProjectSnapshot>();

  public constructor(private readonly editor: EditorPort) {}

  public async inspectProject(): Promise<ProjectSnapshot> {
    const snapshot = await this.editor.readProject();
    this.snapshots.set(snapshot.revision.id, structuredClone(snapshot));
    return snapshot;
  }

  public async changesSince(revision: ContextRevision): Promise<TimelineDiff> {
    const before = this.snapshots.get(revision.id);
    if (!before) throw new Error(`REVISION_NOT_FOUND: ${revision.id}`);
    return diffSnapshots(before, await this.inspectProject());
  }
}
