/** Check the explicitly approved active target before selecting it. */
export async function selectCanonicalWriteTarget(callJson, expected) {
  const catalog = await callJson("project.list");
  const projects = catalog.projects?.filter((project) => project.id === expected.projectId) ?? [];
  if (catalog.activeProjectId !== expected.projectId || catalog.activeSequenceId !== expected.sequenceId
    || projects.length !== 1 || projects[0].name !== expected.projectName
    || projects[0].sequences?.filter((sequence) => sequence.id === expected.sequenceId).length !== 1) {
    throw new Error("TARGET_MISMATCH: active catalog differs from the approved target");
  }
  const selected = await callJson("project.select", { projectId: expected.projectId, sequenceId: expected.sequenceId });
  if (selected.activeProjectId !== expected.projectId || selected.activeSequenceId !== expected.sequenceId) {
    throw new Error("TARGET_MISMATCH: selection differs from the approved target");
  }
}

/** Confirm each headed read against the same approved target. */
export async function readCanonicalWriteTarget(callJson, expected) {
  const snapshot = await callJson("project.inspect", {
    confirmHeadedRead: true,
    expectedTarget: { projectId: expected.projectId, sequenceId: expected.sequenceId },
  });
  if (snapshot.projectId !== expected.projectId || snapshot.projectName !== expected.projectName || snapshot.timeline?.id !== expected.sequenceId) {
    throw new Error("TARGET_MISMATCH: canonical snapshot differs from the approved target");
  }
  return snapshot;
}
