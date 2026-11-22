import type { EditorLiveState, ProjectSnapshot } from "@framekit/runtime";

export interface CanonicalNativeSnapshotTarget {
  projectId: string;
  sequenceId: string;
  projectName: string;
  sequenceName: string;
}

export function createCanonicalNativeSnapshotReader(
  readLiveState: () => Promise<EditorLiveState>,
  readSnapshot: (target: CanonicalNativeSnapshotTarget) => Promise<ProjectSnapshot>,
): () => Promise<ProjectSnapshot> {
  return async () => {
    const live = await readLiveState();
    const project = live.project;
    const sequence = live.sequence;
    if (!project?.id || project.id.startsWith("final-cut:")
      || !project.name.trim() || !sequence?.id || sequence.id.startsWith("final-cut:")
      || !sequence.name.trim()) {
      throw new Error("TARGET_UNAVAILABLE: stable live project and sequence identities are required for canonical export");
    }
    return readSnapshot({
      projectId: project.id,
      sequenceId: sequence.id,
      projectName: project.name,
      sequenceName: sequence.name,
    });
  };
}
