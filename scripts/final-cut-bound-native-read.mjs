/** Resolve the active catalog target before an explicitly confirmed headed read. */
export async function readBoundNativeProject(callJson, expectedProject, expectedSequence) {
  const catalog = await callJson("project.list");
  const projectId = catalog.activeProjectId;
  const sequenceId = catalog.activeSequenceId;
  if (!projectId || !sequenceId) throw new Error("TARGET_UNAVAILABLE: active project and sequence identities are required");
  const projects = catalog.projects?.filter((project) => project.id === projectId) ?? [];
  if (projects.length !== 1) throw new Error("TARGET_MISMATCH: active project is absent or ambiguous in the catalog");
  const project = projects[0];
  if (project.name !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${project.name}`);
  }
  if (expectedSequence && expectedSequence !== sequenceId) {
    throw new Error("FINAL_CUT_E2E_SEQUENCE_MISMATCH: active sequence differs from the expected sequence");
  }
  if (project.sequences?.filter((sequence) => sequence.id === sequenceId).length !== 1) {
    throw new Error("TARGET_MISMATCH: active sequence is absent or ambiguous in the catalog");
  }
  if (!expectedSequence && project.sequences.length !== 1) {
    throw new Error("AMBIGUOUS_PROJECT_TARGET: set FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID for a multi-sequence project");
  }
  const snapshot = await callJson("project.inspect", {
    confirmHeadedRead: true,
    expectedTarget: { projectId, sequenceId },
  });
  if (snapshot.projectId !== projectId || snapshot.timeline?.id !== sequenceId || snapshot.projectName !== expectedProject) {
    throw new Error("TARGET_MISMATCH: canonical snapshot does not match the active catalog target");
  }
  return { catalog, project, sequence: project.sequences.find((sequence) => sequence.id === sequenceId), snapshot };
}
