import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutProjectPublisher } from "@framekit/final-cut";
import type { EditorLiveState } from "@framekit/runtime";

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("publisher readiness requires live verification and a native target-binding provider", () => {
  const liveState = async (): Promise<EditorLiveState> => {
    throw new Error("readiness inspection must not query Final Cut");
  };
  const targetBinding = async () => ({ projectId: "project-1", sequenceId: "sequence-1" });
  const ready = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/source.fcpxml",
    liveState,
    targetBinding,
  });
  assert.deepEqual(ready.inspectReadiness(), {
    available: true,
    targetBindingAvailable: true,
    reasons: [],
  });

  const missingBinding = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/source.fcpxml",
    liveState,
  });
  assert.deepEqual(missingBinding.inspectReadiness(), {
    available: false,
    targetBindingAvailable: false,
    reasons: [{
      code: "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE",
      message: "No native provider can bind the imported artifact to a created target",
    }],
  });
});

test("FCPXML publisher imports a validated artifact as a new project", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-"));
  const artifactDirectory = join(directory, "artifact with spaces");
  await mkdir(artifactDirectory);
  const sourcePath = join(artifactDirectory, "published project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="published-project" name="Published Edit"><sequence uid="published-sequence" name="Published Sequence" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const scripts: string[] = [];
  let liveStateCalls = 0;
  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async (script) => {
      scripts.push(script);
      return "imported";
    },
    targetBinding: async () => ({ projectId: "project-2", sequenceId: "sequence-2" }),
    liveState: async () => ({
      project: liveStateCalls++ === 0
        ? { id: "project-before", name: "Existing Project" }
        : { id: "project-2", name: "Published Edit" },
      sequence: liveStateCalls <= 1
        ? { id: "sequence-before", name: "Existing Sequence", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } }
        : { id: "sequence-2", name: "Published Sequence", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      playheadTime: { value: "0", timescale: "1" },
      sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" } },
      revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  }).publishNewProject({
    sourceTransactionId: "txn-publish-1",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  });

  assert.equal(result.verified, true);
  assert.equal(result.sourceTransactionId, "txn-publish-1");
  assert.equal(result.projectName, "Published Edit");
  assert.equal(result.liveProject, "Published Edit");
  assert.equal(result.liveSequence, "Published Sequence");
  assert.deepEqual(result.sourceTarget, { kind: "artifact", artifactPath: sourcePath });
  assert.deepEqual(result.createdTarget, {
    kind: "editor.project",
    projectId: "project-2",
    sequenceId: "sequence-2",
    projectName: "Published Edit",
    sequenceName: "Published Sequence",
  });
  assert.deepEqual(result.activeProject, {
    before: { id: "project-before", name: "Existing Project" },
    after: { id: "project-2", name: "Published Edit" },
    changed: true,
  });
  assert.match(scripts[0], /waitForMenuItem/);
  assert.match(scripts[0], /waitForImportSheet/);
  assert.match(scripts[0], /waitForSubmenu\(importMenuItem, "Import"/);
  assert.match(scripts[0], /my waitForMenuItem/);
  assert.match(scripts[0], /my waitForSubmenu/);
  assert.match(scripts[0], /my waitForWindow/);
  assert.match(scripts[0], /my waitForImportSheet/);
  assert.match(scripts[0], /my locateImportPathField/);
  assert.match(scripts[0], /my waitForImportSheetDismissal/);
  assert.match(scripts[0], /my waitForImportWindowDismissal/);
  assert.match(scripts[0], /my cancelImportIfOpen/);
  assert.match(scripts[0], /perform action "AXPress"/);
  assert.match(scripts[0], /keystroke "g" using \{command down, shift down\}/);
  assert.match(scripts[0], /text fields of pathSheet/);
  assert.match(scripts[0], /locateImportPathField/);
  assert.match(scripts[0], /value of attribute "AXIdentifier"/);
  assert.match(scripts[0], /description of candidate/);
  assert.match(scripts[0], /FINAL_CUT_PUBLISH_PATH_CONTROL_AMBIGUOUS/);
  assert.equal(scripts[0].includes("set pathField to item 1 of pathFields"), false);
  assert.match(scripts[0], /waitForImportSheetDismissal/);
  assert.match(scripts[0], /on error/);
  assert.match(scripts[0], /Cancel/);
  assert.equal(scripts[0].includes("delay 0.4"), false);
  assert.match(scripts[0], /published project\.fcpxml/);
  await assert.rejects(readFile(result.importedPath), /ENOENT/);
});

test("native FCPXML handoff targets a new library and preserves the approved source", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-library-target-"));
  const sourcePath = join(directory, "approved.fcpxml");
  const targetLibraryPath = join(directory, "Native $1 Handoff.fcpbundle");
  const source = '<?xml version="1.0"?><fcpxml version="1.11"><resources/><import-options><option key="library location" value="file:///old.fcpbundle"/><option key="use-source-media" value="1"/></import-options><library><event><project uid="project-target" name="Target Project"><sequence uid="sequence-target" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let deliveredPath: string | undefined;
  let deliveredXml: string | undefined;
  let liveStateCalls = 0;
  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    documentDelivery: {
      deliverFcpxml: async ({ artifactPath, targetLibraryLocation, activates }) => {
        deliveredPath = artifactPath;
        deliveredXml = await readFile(artifactPath, "utf8");
        assert.equal(targetLibraryLocation, targetLibraryPath);
        assert.equal(activates, false);
        return {
          status: "dispatched",
          route: "background-document-open",
          attempted: true,
          imported: false,
          requestedActivates: false,
          activation: "preserved",
          ui: "unknown",
          target: { requestedLibraryLocation: targetLibraryPath, guarantee: "requested-unverified" },
        };
      },
    },
    targetBinding: async () => ({
      projectId: "native-project",
      sequenceId: "native-sequence",
      libraryId: "native-library",
      eventId: "native-event",
      libraryPath: targetLibraryPath,
    }),
    liveState: async () => ({
      project: liveStateCalls++ === 0
        ? { id: "old-project", name: "Existing" }
        : { id: "native-project", name: "Target Project" },
      sequence: liveStateCalls <= 1
        ? { id: "old-sequence", name: "Old Sequence", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } }
        : { id: "native-sequence", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
    }),
  }).publishNewProject({
    sourceTransactionId: "txn-native-target",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
    confirm: true,
  });

  assert.ok(deliveredPath);
  assert.notEqual(deliveredPath, sourcePath);
  assert.match(deliveredXml ?? "", /<option key="library location" value="file:\/\//);
  assert.match(deliveredXml ?? "", /Native%20\$1%20Handoff\.fcpbundle/);
  assert.match(deliveredXml ?? "", /<option key="use-source-media" value="1"\/>/);
  assert.equal((deliveredXml?.match(/key="library location"/g) ?? []).length, 1);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.equal(result.delivery?.status, "dispatched");
  assert.equal(result.importedDigest, digest(deliveredXml ?? ""));
  assert.notEqual(result.importedDigest, digest(source));
  assert.equal(result.targetLibraryPath, targetLibraryPath);
  assert.deepEqual(result.createdTarget, {
    kind: "editor.project",
    projectId: "native-project",
    sequenceId: "native-sequence",
    libraryId: "native-library",
    eventId: "native-event",
    libraryPath: targetLibraryPath,
    projectName: "Target Project",
    sequenceName: "Main",
  });
  assert.notEqual(result.createdTarget.projectId, "project-target");
  assert.notEqual(result.createdTarget.sequenceId, "sequence-target");
});

test("native FCPXML preview rejects an existing library before dispatch", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-existing-library-"));
  const sourcePath = join(directory, "approved.fcpxml");
  const targetLibraryPath = join(directory, "Existing.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Existing Target"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  await mkdir(targetLibraryPath);
  let dispatchCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    documentDelivery: {
      deliverFcpxml: async () => {
        dispatchCalled = true;
        throw new Error("dispatch must not run for an existing library path");
      },
    },
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => ({ revision: { id: "revision", sequence: 1, timestamp: new Date(0).toISOString() } }),
  });

  await assert.rejects(publisher.preparePublish({
    sourceTransactionId: "txn-existing-library",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  }), /PUBLISH_TARGET_LIBRARY_EXISTS/);
  assert.equal(dispatchCalled, false);
});

test("native FCPXML execution rechecks the new library path after preview", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-library-race-"));
  const sourcePath = join(directory, "approved.fcpxml");
  const targetLibraryPath = join(directory, "Reserved.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Reserved Target"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let dispatchCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    documentDelivery: {
      deliverFcpxml: async () => {
        dispatchCalled = true;
        throw new Error("dispatch must not run after the destination appears");
      },
    },
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => ({ revision: { id: "revision", sequence: 1, timestamp: new Date(0).toISOString() } }),
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-library-race",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  });
  await mkdir(targetLibraryPath);

  const result = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "PUBLISH_TARGET_LIBRARY_EXISTS");
  assert.equal(dispatchCalled, false);
});

test("FCPXML publisher uses the native document-open delivery boundary", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-document-open-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Background Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Background Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const deliveries: Array<{ artifactPath: string; targetLibraryLocation?: string; activates: boolean }> = [];
  let liveStateCalls = 0;

  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    documentDelivery: {
      deliverFcpxml: async (request) => {
        deliveries.push(request);
        return {
          status: "dispatched",
          route: "background-document-open",
          attempted: true,
          imported: false,
          requestedActivates: request.activates,
          activation: "preserved",
          ui: "none",
          target: { requestedLibraryLocation: request.targetLibraryLocation, guarantee: "requested-unverified" },
        };
      },
    },
    targetBinding: async () => ({ projectId: "project-imported", sequenceId: "sequence-imported", libraryPath: targetLibraryPath }),
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => {
      throw new Error("Accessibility fallback must not run");
    },
    liveState: async () => {
      const imported = liveStateCalls++ > 0;
      return {
        project: { id: imported ? "project-imported" : "project-before", name: imported ? "Background Project" : "Existing" },
        sequence: {
          id: imported ? "sequence-imported" : "sequence-before",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
  }).publishNewProject({
    sourceTransactionId: "txn-document-open",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
    confirm: true,
  });

  assert.equal(result.verified, true);
  assert.deepEqual(deliveries, [{ artifactPath: result.importedPath, targetLibraryLocation: targetLibraryPath, activates: false }]);
  assert.equal(result.delivery?.route, "background-document-open");
  assert.equal(result.delivery?.status, "dispatched");
  assert.equal(result.delivery?.requestedActivates, false);
  assert.equal(result.delivery?.activation, "preserved");
});

test("FCPXML publisher requires exact live identity for a library-bound target", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-library-identity-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Bound Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  const incompleteOrMismatchedStates: EditorLiveState[] = [
    { revision: { id: "revision", sequence: 2, timestamp: new Date(0).toISOString() } },
    { project: { id: "project-bound", name: "Bound Project" }, revision: { id: "revision", sequence: 2, timestamp: new Date(0).toISOString() } },
    {
      project: { id: "wrong-project", name: "Bound Project" },
      sequence: { id: "wrong-sequence", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: "revision", sequence: 2, timestamp: new Date(0).toISOString() },
    },
    {
      project: { id: "project-bound", name: "Other Project" },
      sequence: { id: "sequence-bound", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: "revision", sequence: 2, timestamp: new Date(0).toISOString() },
    },
  ];

  for (const [index, invalidState] of incompleteOrMismatchedStates.entries()) {
    const targetLibraryPath = join(directory, `Bound Library ${index}.fcpbundle`);
    await assert.rejects(new FinalCutProjectPublisher({
      enabled: true,
      sourcePath,
      verificationTimeoutMs: 0,
      pollIntervalMs: 0,
      executor: async () => "imported",
      targetBinding: async () => ({
        projectId: "project-bound",
        sequenceId: "sequence-bound",
        libraryPath: targetLibraryPath,
      }),
      liveState: async () => invalidState,
    }).publishNewProject({
      sourceTransactionId: "txn-library-identity",
      artifactPath: sourcePath,
      artifactDigest: digest(source),
      targetLibraryPath,
      confirm: true,
    }), /FINAL_CUT_PUBLISH_(?:TARGET_MISMATCH|VERIFICATION_FAILED)/);
  }
});

test("FCPXML publisher reserves a library path across independent publisher instances", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-library-reservation-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Reserved Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Reserved Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let dispatchStarted!: () => void;
  let releaseDispatch!: () => void;
  const dispatchStartedPromise = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  const dispatchBarrier = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  let dispatchCount = 0;
  const beforeState: EditorLiveState = {
    project: { id: "project-before", name: "Existing" },
    sequence: { id: "sequence-before", name: "Existing", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    revision: { id: "revision-before", sequence: 1, timestamp: new Date(0).toISOString() },
  };
  const importedState: EditorLiveState = {
    project: { id: "project-reserved", name: "Reserved Project" },
    sequence: { id: "sequence-reserved", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    revision: { id: "revision-imported", sequence: 2, timestamp: new Date(1).toISOString() },
  };

  const makePublisher = (observesImport: boolean) => {
    let liveStateCalls = 0;
    return new FinalCutProjectPublisher({
      enabled: true,
      sourcePath,
      verificationTimeoutMs: 0,
      pollIntervalMs: 0,
      documentDelivery: {
        deliverFcpxml: async (request) => {
          dispatchCount += 1;
          if (dispatchCount === 1) {
            dispatchStarted();
            await dispatchBarrier;
            await mkdir(targetLibraryPath);
          }
          return {
            status: "dispatched",
            route: "background-document-open",
            attempted: true,
            imported: false,
            requestedActivates: request.activates,
            activation: "preserved",
            ui: "none",
            target: { requestedLibraryLocation: request.targetLibraryLocation, guarantee: "requested-unverified" },
          };
        },
      },
      targetBinding: async () => ({ projectId: "project-reserved", sequenceId: "sequence-reserved", libraryPath: targetLibraryPath }),
      liveState: async () => {
        liveStateCalls += 1;
        return liveStateCalls === 1 || !observesImport ? beforeState : importedState;
      },
    });
  };

  const firstPublisher = makePublisher(true);
  const secondPublisher = makePublisher(false);
  const firstJob = await firstPublisher.preparePublish({ sourceTransactionId: "txn-reservation-first", artifactPath: sourcePath, artifactDigest: digest(source), targetLibraryPath });
  const secondJob = await secondPublisher.preparePublish({ sourceTransactionId: "txn-reservation-second", artifactPath: sourcePath, artifactDigest: digest(source), targetLibraryPath });

  const firstExecution = firstPublisher.executePublishJob(firstJob.jobId, true);
  await dispatchStartedPromise;
  let secondResult;
  try {
    secondResult = await secondPublisher.executePublishJob(secondJob.jobId, true);
  } finally {
    releaseDispatch();
  }
  const firstResult = await firstExecution;

  assert.equal(secondResult.state, "failed");
  assert.equal(secondResult.retryable, false);
  assert.equal(secondResult.error?.code, "PUBLISH_TARGET_LIBRARY_RESERVED");
  assert.equal(firstResult.state, "verified");
  assert.equal(dispatchCount, 1);
});

test("FCPXML publisher exposes target selection as an interaction-required boundary", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-document-target-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Target Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Needs Target"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;
  let headedFallbackCalled = false;

  await assert.rejects(new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    documentDelivery: {
      deliverFcpxml: async () => ({
        status: "user-interaction-required",
        route: "background-document-open",
        attempted: false,
        imported: false,
        requestedActivates: false,
        activation: "unknown",
        ui: "prompted",
        target: { guarantee: "unavailable" },
        error: {
          code: "FINAL_CUT_DELIVERY_TARGET_UNAVAILABLE",
          message: "Choose a Final Cut library before delivery",
        },
      }),
    },
    executor: async () => {
      headedFallbackCalled = true;
      return "unexpected";
    },
    targetBinding: async () => ({ projectId: "project-imported", sequenceId: "sequence-imported" }),
    liveState: async () => {
      liveStateCalls += 1;
      return { revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } };
    },
  }).publishNewProject({
    sourceTransactionId: "txn-document-target",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
    confirm: true,
  }), /FINAL_CUT_DELIVERY_TARGET_UNAVAILABLE/);

  assert.equal(liveStateCalls, 1);
  assert.equal(headedFallbackCalled, false);
});

test("FCPXML publisher rejects a stale active project with matching names", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-stale-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Shared Name"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const staleState = {
    project: { id: "old-project", name: "Shared Name" },
    sequence: { id: "old-sequence", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    revision: { id: "rev-stale", sequence: 1, timestamp: new Date(0).toISOString() },
  };

  await assert.rejects(new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => "imported",
    targetBinding: async () => ({ projectId: "new-project", sequenceId: "new-sequence" }),
    liveState: async () => staleState,
  }).publishNewProject({
    sourceTransactionId: "txn-stale",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  }), /FINAL_CUT_PUBLISH_TARGET_MISMATCH/);
});

test("FCPXML publisher requires live project and sequence verification", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-state-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  await assert.rejects(new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => "imported",
  }).publishNewProject({
    sourceTransactionId: "txn-no-state",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  }), /FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE/);
});

test("FCPXML publisher is unavailable without live project verification", () => {
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/managed.fcpxml",
  });

  assert.equal(publisher.isAvailable(), false);
});

test("FCPXML publisher is unavailable when the production setup cannot bind a created target", () => {
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/managed.fcpxml",
    documentDelivery: { deliverFcpxml: async () => ({
      status: "user-interaction-required",
      route: "background-document-open",
      attempted: false,
      imported: false,
      requestedActivates: false,
      activation: "unknown",
      ui: "none",
      target: { guarantee: "unavailable" },
    }) },
    liveState: async () => ({
      revision: { id: "revision", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  });

  assert.equal(publisher.isAvailable(), false);
});

test("FCPXML publisher refuses a direct import without a target-binding provider", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-unbound-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Unbound"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    liveState: async () => ({
      project: { id: "before-project", name: "Existing" },
      sequence: { id: "before-sequence", name: "Existing", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: "before-revision", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-unbound",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  }), /FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE/);
  assert.equal(executorCalled, false);
});

test("FCPXML publisher waits for the imported project identity to settle", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-poll-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const states = [
    { project: { id: "before-project", name: "Existing" }, sequence: { id: "before-sequence", name: "Existing" } },
    { project: { id: "before-project", name: "Existing" }, sequence: { id: "before-sequence", name: "Existing" } },
    { project: { id: "imported-project", name: "Published Edit" }, sequence: { id: "imported-sequence", name: "Main" } },
  ];
  let stateIndex = 0;

  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 100,
    pollIntervalMs: 0,
    executor: async () => "imported",
    targetBinding: async () => ({ projectId: "imported-project", sequenceId: "imported-sequence" }),
    liveState: async () => {
      const state = states[Math.min(stateIndex++, states.length - 1)]!;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${stateIndex}`, sequence: stateIndex, timestamp: new Date(0).toISOString() },
      };
    },
  }).publishNewProject({
    sourceTransactionId: "txn-poll",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  });

  assert.equal(result.createdTarget.projectId, "imported-project");
  assert.equal(result.createdTarget.sequenceId, "imported-sequence");
  assert.equal(stateIndex, 3);
});

test("FCPXML publisher retries transient live-state errors", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-transient-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;

  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 100,
    pollIntervalMs: 0,
    executor: async () => "imported",
    targetBinding: async () => ({ projectId: "imported-project", sequenceId: "imported-sequence" }),
    liveState: async () => {
      liveStateCalls += 1;
      if (liveStateCalls === 2) throw new Error("temporary bridge unavailable");
      const imported = liveStateCalls >= 3;
      return {
        project: { id: imported ? "imported-project" : "before-project", name: imported ? "Published Edit" : "Existing" },
        sequence: {
          id: imported ? "imported-sequence" : "before-sequence",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
  }).publishNewProject({
    sourceTransactionId: "txn-transient",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  });

  assert.equal(result.createdTarget.projectId, "imported-project");
  assert.equal(result.createdTarget.sequenceId, "imported-sequence");
  assert.equal(liveStateCalls, 3);
});

test("FCPXML publisher rejects invalid artifacts before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-invalid-"));
  const sourcePath = join(directory, "invalid.fcpxml");
  await writeFile(sourcePath, "not fcpxml");
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });
  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-invalid",
    artifactPath: sourcePath,
    artifactDigest: digest("not fcpxml"),
    confirm: true,
  }), /PUBLISH_VALIDATION_FAILED/);
  assert.equal(called, false);
});

test("FCPXML publisher requires explicit confirmation before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-confirmation-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-publish-2",
    artifactPath: sourcePath,
    artifactDigest: digest('<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>'),
    confirm: false,
  }), /PUBLISH_CONFIRMATION_REQUIRED/);
  assert.equal(called, false);
});

test("FCPXML publisher names the supported runtime configuration when disabled", async () => {
  const publisher = new FinalCutProjectPublisher({
    sourcePath: "/tmp/project.fcpxml",
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-disabled",
    artifactPath: "/tmp/project.fcpxml",
    artifactDigest: "unused",
    confirm: true,
  }), /FRAMEKIT_EDITOR.*FRAMEKIT_FCPXML_PATH.*FRAMEKIT_FINAL_CUT_SOCKET/);
});

test("FCPXML publisher rejects an artifact path outside its managed source", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-target-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-publish-3",
    artifactPath: join(directory, "other.fcpxml"),
    artifactDigest: "unused",
    confirm: true,
  }), /PUBLISH_TARGET_MISMATCH/);
  assert.equal(called, false);
});

test("FCPXML publisher prepares a headed-only handoff without opening Final Cut", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-job-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-job" name="Publish Job"><sequence uid="sequence-job" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;

  const job = await new FinalCutProjectPublisher({
    enabled: false,
    sourcePath,
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
  }).preparePublish({
    sourceTransactionId: "txn-job",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  assert.match(job.jobId, /^publish-job-/);
  assert.equal(job.state, "awaiting-confirmation");
  assert.equal(job.nextAction, "confirm");
  assert.equal(job.retryable, false);
  assert.equal(job.executionMode, "headed-only");
  assert.deepEqual(job.sourceTarget, { kind: "artifact", artifactPath: sourcePath });
  assert.equal(job.sourceTransactionId, "txn-job");
  assert.equal(job.artifactDigest, digest(source));
  assert.equal(executorCalled, false);
});

test("FCPXML publish jobs remain resumable while Final Cut is unavailable", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-waiting-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-waiting" name="Waiting Publish"><sequence uid="sequence-waiting" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: false,
    sourcePath,
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-waiting",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  const waiting = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(waiting.jobId, prepared.jobId);
  assert.equal(waiting.state, "awaiting-final-cut");
  assert.equal(waiting.nextAction, "retry");
  assert.equal(waiting.retryable, true);
  assert.equal(waiting.createdTarget, undefined);
  assert.deepEqual(waiting.error, {
    code: "CAPABILITY_UNAVAILABLE",
    message: "Final Cut project publishing is unavailable; bring Final Cut Pro to the front and retry this job",
  });
  assert.deepEqual(publisher.getPublishJob(prepared.jobId), waiting);
  assert.equal(executorCalled, false);
});

test("FCPXML publish jobs report success only after live target verification", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-verified-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-verified" name="Verified Publish"><sequence uid="sequence-verified" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalls = 0;
  let liveStateCalls = 0;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => {
      executorCalls += 1;
      return "imported";
    },
    targetBinding: async () => ({ projectId: "project-created", sequenceId: "sequence-created" }),
    liveState: async () => {
      liveStateCalls += 1;
      const imported = liveStateCalls > 1;
      return {
        project: { id: imported ? "project-created" : "project-before", name: imported ? "Verified Publish" : "Existing" },
        sequence: {
          id: imported ? "sequence-created" : "sequence-before",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "10", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-verified",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  const verified = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(verified.state, "verified");
  assert.equal(verified.nextAction, "none");
  assert.equal(verified.retryable, false);
  assert.equal(verified.result?.verified, true);
  assert.deepEqual(verified.createdTarget, {
    kind: "editor.project",
    projectId: "project-created",
    sequenceId: "sequence-created",
    projectName: "Verified Publish",
    sequenceName: "Main",
  });
  assert.deepEqual(verified.result?.sourceTarget, { kind: "artifact", artifactPath: sourcePath });
  assert.equal(executorCalls, 1);
  assert.equal(liveStateCalls, 2);
});

test("FCPXML publish jobs resume verification without importing twice", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-resume-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-resume" name="Resume Publish"><sequence uid="sequence-resume" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalls = 0;
  let liveStateCalls = 0;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => {
      executorCalls += 1;
      return "imported";
    },
    targetBinding: async () => ({ projectId: "project-created", sequenceId: "sequence-created" }),
    liveState: async () => {
      liveStateCalls += 1;
      if (liveStateCalls === 2) throw new Error("temporary bridge unavailable");
      const imported = liveStateCalls > 2;
      return {
        project: { id: imported ? "project-created" : "project-before", name: imported ? "Resume Publish" : "Existing" },
        sequence: {
          id: imported ? "sequence-created" : "sequence-before",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "10", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-resume",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  const pending = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(pending.state, "verification-pending");
  assert.equal(pending.nextAction, "retry");
  assert.equal(pending.retryable, true);
  assert.equal(pending.createdTarget, undefined);
  assert.match(pending.error?.code ?? "", /FINAL_CUT_PUBLISH_STATE_UNAVAILABLE/);

  const resumed = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(resumed.state, "verified");
  assert.equal(resumed.result?.verified, true);
  assert.deepEqual(resumed.createdTarget, {
    kind: "editor.project",
    projectId: "project-created",
    sequenceId: "sequence-created",
    projectName: "Resume Publish",
    sequenceName: "Main",
  });
  assert.equal(executorCalls, 1);
  assert.equal(liveStateCalls, 3);
});

test("FCPXML publish jobs recheck the source digest before execution", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-digest-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-digest" name="Digest Publish"><sequence uid="sequence-digest" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
    liveState: async () => ({
      project: { id: "project-before", name: "Existing" },
      sequence: {
        id: "sequence-before",
        name: "Existing",
        startTime: { value: "0", timescale: "1" },
        duration: { value: "1", timescale: "1" },
        frameDuration: { value: "1", timescale: "24" },
      },
      revision: { id: "revision-before", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-digest",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });
  await writeFile(sourcePath, `${source}\nchanged`);

  const failed = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(failed.state, "failed");
  assert.equal(failed.retryable, false);
  assert.deepEqual(failed.error, {
    code: "PUBLISH_SOURCE_CHANGED",
    message: "PUBLISH_SOURCE_CHANGED: managed FCPXML artifact changed after transaction verification",
  });
  assert.equal(failed.createdTarget, undefined);
  assert.equal(executorCalled, false);

  await writeFile(sourcePath, source);
  const terminal = await publisher.executePublishJob(prepared.jobId, true);

  assert.deepEqual(terminal, failed);
  assert.equal(executorCalled, false);
});

test("FCPXML publish jobs fail closed without target binding proof", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-binding-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-binding" name="Binding Publish"><sequence uid="sequence-binding" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
    liveState: async () => ({
      project: { id: "project-before", name: "Existing" },
      sequence: {
        id: "sequence-before",
        name: "Existing",
        startTime: { value: "0", timescale: "1" },
        duration: { value: "1", timescale: "1" },
        frameDuration: { value: "1", timescale: "24" },
      },
      revision: { id: "revision-before", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-binding",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  const failed = await publisher.executePublishJob(prepared.jobId, true);

  assert.equal(failed.state, "failed");
  assert.equal(failed.retryable, false);
  assert.deepEqual(failed.error, {
    code: "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE",
    message: "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no import was attempted",
  });
  assert.equal(failed.createdTarget, undefined);
  assert.equal(executorCalled, false);
});
