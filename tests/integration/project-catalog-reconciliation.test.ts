import assert from "node:assert/strict";
import test from "node:test";
import { reconcileProjectCatalog, type ProjectCatalogReconciliationOptions } from "@framekit/runtime";
import type {
  ContextRevision,
  EditorLiveState,
  ProjectCatalog,
} from "@framekit/runtime";

const catalog: ProjectCatalog = {
  projects: [
    {
      id: "library-project",
      name: "Edit Project",
      sequences: [{ id: "library-sequence", name: "Main" }],
    },
  ],
};

const provenance: ProjectCatalogReconciliationOptions["provenance"] = {
  catalog: {
    source: "background-library",
    backend: "final-cut-background-library",
    guarantee: "observed",
  },
  live: {
    source: "live-socket",
    backend: "workflow-extension-ipc",
    guarantee: "observed",
  },
  selection: {
    available: false,
    mode: "unavailable",
    unavailableReason: "project selection is not exposed by the background provider",
  },
};

function revision(sequence: number): ContextRevision {
  return { id: `live-${sequence}`, sequence, timestamp: new Date(sequence).toISOString() };
}

function liveState(
  projectId: string,
  projectName: string,
  sequenceId: string,
  sequenceName: string,
  currentRevision: ContextRevision,
): EditorLiveState {
  return {
    project: { id: projectId, name: projectName },
    sequence: {
      id: sequenceId,
      name: sequenceName,
      startTime: { value: "0", timescale: "24" },
      duration: { value: "240", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    playheadTime: { value: "48", timescale: "24" },
    revision: currentRevision,
  };
}

test("stable project and sequence IDs reconcile with observed live timing", () => {
  const state = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(4),
  );

  const reconciled = reconcileProjectCatalog(catalog, {
    before: state,
    after: state,
    provenance,
  });

  assert.equal(reconciled.activeProjectId, "library-project");
  assert.equal(reconciled.activeSequenceId, "library-sequence");
  assert.equal(reconciled.provenance?.reconciliation.status, "matched");
  assert.equal(reconciled.provenance?.reconciliation.project.method, "stable-id");
  assert.deepEqual(reconciled.provenance?.live?.state.sequence?.duration, {
    value: "240",
    timescale: "24",
  });
  assert.deepEqual(reconciled.provenance?.live?.state.playheadTime, {
    value: "48",
    timescale: "24",
  });
});

test("name-only matches remain unresolved and do not create active IDs", () => {
  const state = liveState(
    "socket-project",
    "Edit Project",
    "socket-sequence",
    "Main",
    revision(4),
  );

  const reconciled = reconcileProjectCatalog(catalog, {
    before: state,
    after: state,
    provenance,
  });

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.activeSequenceId, undefined);
  assert.equal(reconciled.provenance?.reconciliation.status, "unresolved");
  assert.equal(reconciled.provenance?.reconciliation.project.method, "name-only");
  assert.equal(reconciled.provenance?.reconciliation.sequence.method, "name-only");
});

test("revision changes return a stale catalog that requires a fresh read", () => {
  const before = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(4),
  );
  const after = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(5),
  );

  const reconciled = reconcileProjectCatalog(catalog, {
    before,
    after,
    provenance,
  });

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.provenance?.reconciliation.status, "stale");
  assert.match(reconciled.provenance?.reconciliation.reason ?? "", /revision changed/);
});

test("target changes return a stale catalog even when names remain similar", () => {
  const before = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(4),
  );
  const after = liveState(
    "other-project",
    "Other Project",
    "other-sequence",
    "Main",
    revision(5),
  );

  const reconciled = reconcileProjectCatalog(catalog, {
    before,
    after,
    provenance,
  });

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.provenance?.reconciliation.status, "stale");
  assert.match(reconciled.provenance?.reconciliation.reason ?? "", /target changed/);
});

test("invalid live timing and regressed revisions fail closed", () => {
  const invalidTiming = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(4),
  );
  invalidTiming.sequence!.duration = { value: "not-rational", timescale: "24" };
  assert.throws(
    () => reconcileProjectCatalog(catalog, { after: invalidTiming, provenance }),
    /PROJECT_CATALOG_INVALID: live sequence duration must use an integer value and positive timescale/,
  );

  const before = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(4),
  );
  const regressed = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(3),
  );
  assert.throws(
    () => reconcileProjectCatalog(catalog, { before, after: regressed, provenance }),
    /PROJECT_CATALOG_INVALID: live revision sequence regressed/,
  );
});
