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
  assert.deepEqual((reconciled.provenance?.reconciliation as { diagnostics?: unknown[] }).diagnostics, [
    {
      scope: "project",
      code: "stable-id-mismatch",
      liveId: "socket-project",
      liveName: "Edit Project",
      catalogId: "library-project",
    },
    {
      scope: "sequence",
      code: "stable-id-mismatch",
      liveId: "socket-sequence",
      liveName: "Main",
      catalogId: "library-sequence",
    },
  ]);
});

test("stable-ID mismatches require explicit target selection", () => {
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
  const reconciliation = reconciled.provenance?.reconciliation;
  assert.ok(reconciliation);
  const detailedReconciliation = reconciliation as typeof reconciliation & {
    blocker?: { code: string; message: string };
  };

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.activeSequenceId, undefined);
  assert.deepEqual(detailedReconciliation.blocker, {
    code: "target-selection-required",
    message: "target selection is required before canonical operations",
  });
});

test("ambiguous sequence names remain unresolved with candidate identities", () => {
  const ambiguousCatalog: ProjectCatalog = {
    projects: [{
      id: "library-project",
      name: "Edit Project",
      sequences: [
        { id: "library-sequence-main", name: "Main" },
        { id: "library-sequence-copy", name: "Main" },
      ],
    }],
  };
  const state = liveState(
    "library-project",
    "Edit Project",
    "socket-sequence",
    "Main",
    revision(4),
  );

  const reconciled = reconcileProjectCatalog(ambiguousCatalog, {
    before: state,
    after: state,
    provenance,
  });
  const reconciliation = reconciled.provenance?.reconciliation;
  assert.ok(reconciliation);
  const detailedReconciliation = reconciliation as typeof reconciliation & {
    diagnostics?: unknown[];
  };

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.activeSequenceId, undefined);
  assert.equal(detailedReconciliation.status, "unresolved");
  assert.equal(detailedReconciliation.project.method, "stable-id");
  assert.equal(detailedReconciliation.sequence.method, "ambiguous-name");
  assert.deepEqual(detailedReconciliation.sequence.candidateCatalogIds, [
    "library-sequence-main",
    "library-sequence-copy",
  ]);
  assert.deepEqual(detailedReconciliation.diagnostics, [{
    scope: "sequence",
    code: "ambiguous-name",
    liveId: "socket-sequence",
    liveName: "Main",
    candidateCatalogIds: ["library-sequence-main", "library-sequence-copy"],
  }]);
});

test("ambiguous project names remain unresolved before sequence matching", () => {
  const ambiguousCatalog: ProjectCatalog = {
    projects: [
      {
        id: "library-project-one",
        name: "Edit Project",
        sequences: [{ id: "library-sequence-one", name: "Main" }],
      },
      {
        id: "library-project-two",
        name: "Edit Project",
        sequences: [{ id: "library-sequence-two", name: "Main" }],
      },
    ],
  };
  const state = liveState(
    "socket-project",
    "Edit Project",
    "socket-sequence",
    "Main",
    revision(4),
  );

  const reconciled = reconcileProjectCatalog(ambiguousCatalog, {
    before: state,
    after: state,
    provenance,
  });
  const reconciliation = reconciled.provenance?.reconciliation;
  assert.ok(reconciliation);
  const detailedReconciliation = reconciliation as typeof reconciliation & {
    diagnostics?: unknown[];
  };

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.activeSequenceId, undefined);
  assert.equal(detailedReconciliation.project.method, "ambiguous-name");
  assert.deepEqual(detailedReconciliation.project.candidateCatalogIds, [
    "library-project-one",
    "library-project-two",
  ]);
  assert.deepEqual(detailedReconciliation.diagnostics, [{
    scope: "project",
    code: "ambiguous-name",
    liveId: "socket-project",
    liveName: "Edit Project",
    candidateCatalogIds: ["library-project-one", "library-project-two"],
  }]);
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

test("background active target disagreement returns a stale catalog", () => {
  const mismatchedCatalog: ProjectCatalog = {
    ...catalog,
    projects: [
      ...catalog.projects,
      {
        id: "other-project",
        name: "Other Project",
        sequences: [{ id: "other-sequence", name: "Other" }],
      },
    ],
    activeProjectId: "other-project",
    activeSequenceId: "other-sequence",
  };
  const state = liveState(
    "library-project",
    "Edit Project",
    "library-sequence",
    "Main",
    revision(4),
  );

  const reconciled = reconcileProjectCatalog(mismatchedCatalog, {
    before: state,
    after: state,
    provenance,
  });

  assert.equal(reconciled.activeProjectId, undefined);
  assert.equal(reconciled.provenance?.reconciliation.status, "stale");
  assert.match(reconciled.provenance?.reconciliation.reason ?? "", /background active target differs/);
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
