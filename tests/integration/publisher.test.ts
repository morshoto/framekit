import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { FcpxmlDocumentAdapter, FinalCutProjectPublisher, parseFinalCutProjectPublishRoute } from "@framekit/final-cut";
import type { EditorLiveState } from "@framekit/runtime";

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("publish route configuration is explicit and rejects unknown routes", () => {
  assert.equal(parseFinalCutProjectPublishRoute(undefined, true), "background-document-open");
  assert.equal(parseFinalCutProjectPublishRoute(undefined, false), "headed-apple-event");
  assert.equal(parseFinalCutProjectPublishRoute("headed-apple-event", true), "headed-apple-event");
  assert.equal(parseFinalCutProjectPublishRoute("background-document-open", false), "background-document-open");
  assert.throws(() => parseFinalCutProjectPublishRoute("fallback", true), /FRAMEKIT_FINAL_CUT_PUBLISH_ROUTE_INVALID/);
});

test("publisher readiness requires live verification, target binding, and canonical readback", () => {
  const liveState = async (): Promise<EditorLiveState> => {
    throw new Error("readiness inspection must not query Final Cut");
  };
  const readCanonicalSnapshot = async () => {
    throw new Error("readiness inspection must not read Final Cut");
  };
  const targetBinding = async () => ({ projectId: "project-1", sequenceId: "sequence-1" });
  const ready = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/source.fcpxml",
    liveState,
    targetBinding,
    readCanonicalSnapshot,
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
    readCanonicalSnapshot,
  });
  assert.deepEqual(missingBinding.inspectReadiness(), {
    available: false,
    targetBindingAvailable: false,
    reasons: [{
      code: "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE",
      message: "No native provider can bind the imported artifact to a created target",
    }],
  });
  const missingReadback = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/source.fcpxml",
    liveState,
    targetBinding,
  });
  assert.deepEqual(missingReadback.inspectReadiness(), {
    available: false,
    targetBindingAvailable: true,
    reasons: [{
      code: "FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE",
      message: "Headed canonical timeline readback is unavailable",
    }],
  });

  const missingLiveState = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: "/tmp/source.fcpxml",
    targetBinding,
    readCanonicalSnapshot,
  });
  assert.deepEqual(missingLiveState.inspectReadiness(), {
    available: false,
    targetBindingAvailable: true,
    reasons: [{
      code: "FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE",
      message: "Live Final Cut project and sequence verification is unavailable",
    }],
  });
});

function createPublisherForTest(options: ConstructorParameters<typeof FinalCutProjectPublisher>[0]) {
  return new FinalCutProjectPublisher({
    ...options,
    readCanonicalSnapshot: options.readCanonicalSnapshot
      ?? (() => new FcpxmlDocumentAdapter(options.sourcePath, undefined, {
        allowMissingImmutableIdsForReadback: true,
      }).readProject()),
  });
}

test("FCPXML publisher imports a validated artifact as a new project", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-"));
  const artifactDirectory = join(directory, "artifact with spaces");
  await mkdir(artifactDirectory);
  const sourcePath = join(artifactDirectory, "published project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="published-project" name="Published Edit"><sequence uid="published-sequence" name="Published Sequence" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const scripts: string[] = [];
  let liveStateCalls = 0;
  const result = await createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  });

  assert.equal(result.verified, true);
  assert.equal(result.semanticReadback.verified, true);
  assert.equal(result.semanticReadback.expectedDigest, result.semanticReadback.observedDigest);
  assert.deepEqual(result.sourceMediaIntegrity, { unchanged: true, digests: [] });
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
  assert.match(scripts[0], /tell application "Final Cut Pro"\s+activate\s+open POSIX file ".*published project\.fcpxml"\s+end tell/);
  assert.doesNotMatch(scripts[0], /System Events|Import XML|key code|keystroke/);
  assert.equal(scripts[0].includes(sourcePath), false);
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
  const result = await createPublisherForTest({
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
    confirm: true, confirmVerification: true,
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
  const publisher = createPublisherForTest({
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
  const publisher = createPublisherForTest({
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

  const result = await createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  });

  assert.equal(result.verified, true);
  assert.deepEqual(deliveries, [{ artifactPath: result.importedPath, targetLibraryLocation: targetLibraryPath, activates: false }]);
  assert.equal(result.delivery?.route, "background-document-open");
  assert.equal(result.delivery?.status, "dispatched");
  assert.equal(result.delivery?.requestedActivates, false);
  assert.equal(result.delivery?.activation, "preserved");
});

test("FCPXML publisher does not fallback after an attempted background open", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-headed-fallback-"));
  const sourcePath = join(directory, "project.fcpxml");
  const disabledTargetLibraryPath = join(directory, "Fallback Disabled.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Fallback Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  const failedDelivery = {
    deliverFcpxml: async (request: { targetLibraryLocation?: string; activates: boolean }) => ({
      status: "failed" as const,
      route: "background-document-open" as const,
      attempted: true,
      imported: false,
      requestedActivates: request.activates,
      activation: "unknown" as const,
      ui: "unknown" as const,
      target: { requestedLibraryLocation: request.targetLibraryLocation, guarantee: "requested-unverified" as const },
      error: { code: "FINAL_CUT_DELIVERY_OPEN_FAILED", message: "Final Cut could not open the staged document" },
    }),
  };
  let liveStateCalls = 0;
  const fallbackScripts: string[] = [];
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    documentDelivery: failedDelivery,
    publishRoute: "background-document-open",
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    targetBinding: async () => ({ projectId: "fallback-project", sequenceId: "fallback-sequence", libraryPath: disabledTargetLibraryPath }),
    liveState: async () => {
      liveStateCalls += 1;
      return { revision: { id: `before-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() } };
    },
    executor: async (script) => {
      fallbackScripts.push(script);
      return "opened";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-attempted-headed-fallback",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath: disabledTargetLibraryPath,
    confirm: true, confirmVerification: true,
  }), /FINAL_CUT_PUBLISH_VERIFICATION_PENDING/);
  assert.deepEqual(fallbackScripts, []);
  assert.equal(liveStateCalls, 1);
});

test("FCPXML publisher previews and dispatches the selected headed route once", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-selected-route-"));
  const sourcePath = join(directory, "selected route.fcpxml");
  const targetLibraryPath = join(directory, "Approved Target.fcpbundle");
  const publishJobsDirectory = join(directory, "publish-jobs");
  const source = '<fcpxml version="1.11"><library><event><project name="Selected Route"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  let liveStateCalls = 0;
  const appleScripts: string[] = [];
  let stagedXml = "";
  let backgroundDeliveries = 0;
  const options = {
    enabled: true,
    sourcePath,
    publishJobsDirectory,
    publishRoute: "headed-apple-event" as const,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    documentDelivery: {
      deliverFcpxml: async () => {
        backgroundDeliveries += 1;
        throw new Error("selected headed route must not use background delivery");
      },
    },
    executor: async (script: string) => {
      appleScripts.push(script);
      const stagedPath = /open POSIX file "([^"]+)"/.exec(script)?.[1];
      if (stagedPath) stagedXml = await readFile(stagedPath, "utf8");
      return "opened";
    },
    targetBinding: async (path: string | undefined) => ({
      projectId: "selected-project",
      sequenceId: "selected-sequence",
      libraryPath: path,
    }),
    liveState: async () => {
      const imported = liveStateCalls++ > 0;
      return {
        project: { id: imported ? "selected-project" : "existing-project", name: imported ? "Selected Route" : "Existing" },
        sequence: {
          id: imported ? "selected-sequence" : "existing-sequence",
          name: "Main",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
  } as ConstructorParameters<typeof FinalCutProjectPublisher>[0];
  const publisher = createPublisherForTest(options);
  const preview = await publisher.preparePublish({
    sourceTransactionId: "txn-selected-route",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  });

  assert.equal((preview.handoff as { route?: string }).route, "headed-apple-event");
  assert.match(preview.handoff.reason, /activates Final Cut Pro/i);
  const restartedPublisher = createPublisherForTest({
    ...options,
    publishRoute: "background-document-open",
  });
  assert.equal(restartedPublisher.getPublishJob(preview.jobId).handoff.route, "headed-apple-event");
  assert.equal((await restartedPublisher.executePublishJob(preview.jobId, true)).state, "verification-pending");
  assert.equal((await restartedPublisher.executePublishJob(preview.jobId, true, true)).state, "verified");
  assert.equal(backgroundDeliveries, 0);
  assert.equal(appleScripts.length, 1);
  assert.match(appleScripts[0] ?? "", /open POSIX file ".*selected route\.fcpxml"/);
  assert.match(appleScripts[0] ?? "", /tell application "Final Cut Pro"\s+activate/);
  assert.doesNotMatch(appleScripts[0] ?? "", /System Events|Import XML|key code|keystroke/);
  assert.match(stagedXml, new RegExp(`key="library location" value="file://${targetLibraryPath.replaceAll(" ", "%20")}`));
  assert.equal(restartedPublisher.getPublishJob(preview.jobId).result?.delivery?.route, "headed-apple-event");
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
    await assert.rejects(createPublisherForTest({
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
      confirm: true, confirmVerification: true,
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
    return createPublisherForTest({
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
  const firstPending = await firstExecution;
  assert.equal(firstPending.state, "verification-pending");
  const firstResult = await firstPublisher.executePublishJob(firstJob.jobId, true, true);

  assert.equal(secondResult.state, "failed");
  assert.equal(secondResult.retryable, false);
  assert.equal(secondResult.error?.code, "PUBLISH_TARGET_LIBRARY_RESERVED");
  assert.equal(firstResult.state, "verified");
  assert.equal(dispatchCount, 1);
});

test("FCPXML publisher recovers a dead reservation only when its target is absent", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-stale-reservation-"));
  const sourcePath = join(directory, "project.fcpxml");
  const canonicalTargetParent = join(directory, "canonical-target-parent");
  const aliasedTargetParent = join(directory, "aliased-target-parent");
  await mkdir(canonicalTargetParent);
  await symlink(canonicalTargetParent, aliasedTargetParent, "dir");
  const targetLibraryPath = join(aliasedTargetParent, "Stale Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Stale Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const reservationPath = await reservationPathFor(targetLibraryPath);
  await writeFile(reservationPath, JSON.stringify({
    reservationId: "abandoned-reservation",
    phase: "reserved",
    targetLibraryPath: join(await realpath(aliasedTargetParent), basename(targetLibraryPath)),
    // This is outside the PID range used by supported macOS and Linux runners.
    pid: 2_147_483_647,
    createdAt: new Date(0).toISOString(),
  }));
  let liveStateCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => "imported",
    targetBinding: async () => ({ projectId: "project-stale", sequenceId: "sequence-stale", libraryPath: targetLibraryPath }),
    liveState: async () => liveStateCalls++ === 0
      ? { revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } }
      : {
        project: { id: "project-stale", name: "Stale Project" },
        sequence: { id: "sequence-stale", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
        revision: { id: "after", sequence: 2, timestamp: new Date(1).toISOString() },
      },
  });

  const result = await publisher.publishNewProject({
    sourceTransactionId: "txn-stale-reservation",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
    confirm: true, confirmVerification: true,
  });

  assert.equal(result.verified, true);
  await assert.rejects(readFile(reservationPath), { code: "ENOENT" });
});

test("FCPXML publisher allows only one process to recover a stale library reservation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-concurrent-recovery-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Concurrent Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Concurrent Project"><sequence name="Main" /></project></event></library></fcpxml>';
  const rendezvous = join(directory, "rendezvous");
  await mkdir(rendezvous);
  await writeFile(sourcePath, source);
  const reservationPath = await reservationPathFor(targetLibraryPath);
  await writeFile(reservationPath, JSON.stringify({
    reservationId: "abandoned-concurrent-reservation",
    phase: "reserved",
    targetLibraryPath: join(await realpath(dirname(targetLibraryPath)), basename(targetLibraryPath)),
    pid: 2_000_000_000,
    createdAt: new Date(0).toISOString(),
  }));

  const workerSource = `
    import { access, mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { FcpxmlDocumentAdapter, FinalCutProjectPublisher } from "@framekit/final-cut";
    const { sourcePath, targetLibraryPath, rendezvous, workerId } = process.env;
    const marker = (name) => join(rendezvous, name);
    const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(marker("ready-" + workerId), "ready");
    while (!(await exists(marker("start")))) await pause();
    let stateCalls = 0;
    const publisher = new FinalCutProjectPublisher({
      enabled: true,
      sourcePath,
      verificationTimeoutMs: 0,
      pollIntervalMs: 0,
      executor: async () => {
        await writeFile(marker("started-" + workerId), "started");
        while (!(await exists(marker("release")))) await pause();
        await mkdir(targetLibraryPath);
        return "imported";
      },
      targetBinding: async () => ({ projectId: "project-" + workerId, sequenceId: "sequence-" + workerId, libraryPath: targetLibraryPath }),
      readCanonicalSnapshot: async () => new FcpxmlDocumentAdapter(sourcePath, undefined, {
        allowMissingImmutableIdsForReadback: true,
      }).readProject(),
      liveState: async () => stateCalls++ === 0
        ? { revision: { id: "before-" + workerId, sequence: 1, timestamp: new Date(0).toISOString() } }
        : {
          project: { id: "project-" + workerId, name: "Concurrent Project" },
          sequence: { id: "sequence-" + workerId, name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
          revision: { id: "after-" + workerId, sequence: 2, timestamp: new Date(1).toISOString() },
        },
    });
    try {
      const result = await publisher.publishNewProject({
        sourceTransactionId: "txn-concurrent-" + workerId,
        artifactPath: sourcePath,
        artifactDigest: ${JSON.stringify(digest(source))},
        targetLibraryPath,
        confirm: true, confirmVerification: true,
      });
      process.stdout.write("verified:" + result.createdTarget.projectId);
    } catch (error) {
      process.stdout.write("error:" + (error instanceof Error ? error.message : String(error)));
    }
  `;
  const workerCount = 6;
  let closedWorkers = 0;
  const workers = Array.from({ length: workerCount }, (_, index) => {
    const workerId = String(index);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", workerSource], {
      cwd: process.cwd(),
      env: { ...process.env, sourcePath, targetLibraryPath, rendezvous, workerId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const closed = new Promise<{ code: number | null; output: string; errors: string }>((resolve) => {
      child.once("close", (code) => {
        closedWorkers += 1;
        resolve({ code, output, errors });
      });
    });
    return { child, closed };
  });

  const waitFor = async (predicate: (names: string[]) => boolean, description: string): Promise<string[]> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const names = await readdir(rendezvous);
      if (predicate(names)) return names;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for publisher workers: ${description}`);
  };

  try {
    await waitFor((names) => names.filter((name) => name.startsWith("ready-")).length === workerCount, "all workers ready");
    await writeFile(join(rendezvous, "start"), "start");
    const attempted = await waitFor((names) => closedWorkers + names.filter((name) => name.startsWith("started-")).length === workerCount, "all workers to reserve or reject");
    const started = attempted.filter((name) => name.startsWith("started-"));
    await writeFile(join(rendezvous, "release"), "release");
    const results = await Promise.all(workers.map(({ closed }) => closed));

    assert.equal(started.length, 1, `only one process may import; started: ${started.join(", ")}; results: ${JSON.stringify(results)}`);
    assert.equal(results.filter(({ output }) => output.startsWith("verified:")).length, 1);
    assert.equal(results.filter(({ output }) => output.startsWith("error:PUBLISH_TARGET_LIBRARY_RESERVED:")).length, workerCount - 1);
    assert.deepEqual(results.map(({ code }) => code), Array(workerCount).fill(0));
    assert.deepEqual(results.filter(({ errors }) => errors.length > 0), []);
  } finally {
    await writeFile(join(rendezvous, "start"), "start").catch(() => undefined);
    await writeFile(join(rendezvous, "release"), "release").catch(() => undefined);
    for (const { child } of workers) child.kill();
  }
});

test("FCPXML publisher keeps malformed, legacy and live-process reservations", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-protected-reservation-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Protected Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  for (const index of [0, 1, 2]) {
    const targetLibraryPath = join(directory, `Protected Library ${index}.fcpbundle`);
    const reservationPath = await reservationPathFor(targetLibraryPath);
    const contents = index === 0
      ? "not-json"
      : JSON.stringify({ reservationId: "protected-reservation", targetLibraryPath, pid: index === 1 ? process.pid : 2_147_483_647 });
    await writeFile(reservationPath, contents);
    const publisher = createPublisherForTest({
      enabled: true,
      sourcePath,
      executor: async () => "must not import",
      targetBinding: async () => ({ projectId: "project-protected", sequenceId: "sequence-protected" }),
      liveState: async () => ({ revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } }),
    });

    await assert.rejects(publisher.publishNewProject({
      sourceTransactionId: `txn-protected-reservation-${index}`,
      artifactPath: sourcePath,
      artifactDigest: digest(source),
      targetLibraryPath,
      confirm: true, confirmVerification: true,
    }), /PUBLISH_TARGET_LIBRARY_RESERVED/);
    assert.equal(await readFile(reservationPath, "utf8"), contents);
  }
});

test("FCPXML direct publish transfers an ambiguous reservation to a resumable job", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-direct-recovery-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Pending Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Pending Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => { throw new Error("native import outcome is uncertain"); },
    targetBinding: async () => ({ projectId: "project-pending", sequenceId: "sequence-pending", libraryPath: targetLibraryPath }),
    liveState: async () => liveStateCalls++ === 0
      ? { revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } }
      : {
        project: { id: "project-pending", name: "Pending Project" },
        sequence: { id: "sequence-pending", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
        revision: { id: "after", sequence: 2, timestamp: new Date(1).toISOString() },
      },
  });

  let publishError: Error | undefined;
  try {
    await publisher.publishNewProject({
      sourceTransactionId: "txn-direct-pending",
      artifactPath: sourcePath,
      artifactDigest: digest(source),
      targetLibraryPath,
      confirm: true, confirmVerification: true,
    });
  } catch (error) {
    publishError = error as Error;
  }
  const jobId = publishError?.message.match(/publish job ([\w-]+)/)?.[1];

  assert.ok(jobId, "direct publish failure should expose its verification job id");
  assert.equal(publisher.getPublishJob(jobId).state, "verification-pending");
  assert.match(await readFile(await reservationPathFor(targetLibraryPath), "utf8"), /reservationId/);
  const resumed = await publisher.executePublishJob(jobId, true, true);
  assert.equal(resumed.state, "verified");
  await assert.rejects(readFile(await reservationPathFor(targetLibraryPath)), { code: "ENOENT" });
});

test("retained direct publish reports headed verification when document delivery is configured", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-direct-mode-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Pending Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Pending Project"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    documentDelivery: {
      deliverFcpxml: async () => { throw new Error("native import outcome is uncertain"); },
    },
    targetBinding: async () => ({ projectId: "project-pending", sequenceId: "sequence-pending" }),
    liveState: async () => ({ revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } }),
  });

  let publishError: Error | undefined;
  try {
    await publisher.publishNewProject({
      sourceTransactionId: "txn-direct-mode",
      artifactPath: sourcePath,
      artifactDigest: digest(source),
      targetLibraryPath,
      confirm: true, confirmVerification: true,
    });
  } catch (error) {
    publishError = error as Error;
  }
  const jobId = publishError?.message.match(/publish job ([\w-]+)/)?.[1];
  assert.ok(jobId, "direct publish failure should expose its verification job id");
  const job = publisher.getPublishJob(jobId);
  assert.equal(job.state, "verification-pending");
  assert.equal(job.executionMode, "headed-only");
  assert.equal(job.handoff.mode, "headed-only");
  assert.equal(job.handoff.backgroundSupported, false);
});

async function reservationPathFor(targetLibraryPath: string): Promise<string> {
  const requestedTarget = resolve(targetLibraryPath);
  const parent = await realpath(dirname(requestedTarget));
  const targetName = basename(requestedTarget).normalize("NFC");
  const reservationKey = join(parent, targetName);
  const normalizedKey = process.platform === "darwin" ? reservationKey.toLowerCase() : reservationKey;
  return join(parent, `.framekit-publish-${digest(normalizedKey)}.lock`);
}

test("FCPXML publisher exposes target selection as an interaction-required boundary", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-document-target-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "Target Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project name="Needs Target"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;
  let headedFallbackCalled = false;

  await assert.rejects(createPublisherForTest({
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
    confirm: true, confirmVerification: true,
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

  await assert.rejects(createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  }), /FINAL_CUT_PUBLISH_TARGET_MISMATCH/);
});

test("FCPXML publisher requires live project and sequence verification", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-state-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  await assert.rejects(createPublisherForTest({
    enabled: true,
    sourcePath,
    executor: async () => "imported",
  }).publishNewProject({
    sourceTransactionId: "txn-no-state",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true, confirmVerification: true,
  }), /FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE/);
});

test("FCPXML publisher is unavailable without live project verification", () => {
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath: "/tmp/managed.fcpxml",
  });

  assert.equal(publisher.isAvailable(), false);
});

test("FCPXML publisher refuses to import without headed semantic readback", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-readback-unavailable-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="readback-project" name="Readback"><sequence uid="readback-sequence" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => ({ revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } }),
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
  });

  assert.equal(publisher.isAvailable(), false);
  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-readback-unavailable",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true, confirmVerification: true,
  }), /FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE/);
  assert.equal(executorCalled, false);
});

test("FCPXML publisher refuses to import when approved source media is missing", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-media-missing-"));
  const sourcePath = join(directory, "project.fcpxml");
  const missingMediaPath = join(directory, "missing clip.mp4");
  const source = `<fcpxml version="1.11"><resources><asset id="r1" name="clip.mp4" src="${pathToFileURL(missingMediaPath).href}" duration="1s" hasVideo="1" /></resources><library><event><project uid="media-project" name="Media"><sequence uid="media-sequence" name="Main" duration="1s"><spine><asset-clip id="clip" ref="r1" name="clip.mp4" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`;
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => ({ revision: { id: "before", sequence: 1, timestamp: new Date(0).toISOString() } }),
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-media-missing",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true, confirmVerification: true,
  }), /FINAL_CUT_PUBLISH_SOURCE_MEDIA_UNAVAILABLE/);
  assert.equal(executorCalled, false);
});

test("FCPXML publisher detects source media mutation during native publishing", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-media-changed-"));
  const sourcePath = join(directory, "project.fcpxml");
  const mediaPath = join(directory, "clip.mp4");
  await writeFile(mediaPath, "approved media bytes");
  const source = `<fcpxml version="1.11"><resources><asset id="r1" name="clip.mp4" src="${pathToFileURL(mediaPath).href}" duration="1s" hasVideo="1" /></resources><library><event><project uid="media-project" name="Media"><sequence uid="media-sequence" name="Main" duration="1s"><spine><asset-clip id="clip" ref="r1" name="clip.mp4" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`;
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => {
      const imported = liveStateCalls++ > 0;
      return {
        project: { id: imported ? "native-project" : "before-project", name: imported ? "Media" : "Existing" },
        sequence: {
          id: imported ? "native-sequence" : "before-sequence",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
    executor: async () => {
      await writeFile(mediaPath, "changed media bytes");
      return "imported";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-media-changed",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true, confirmVerification: true,
  }), /FINAL_CUT_PUBLISH_SOURCE_MEDIA_CHANGED/);
});

test("FCPXML publish success includes unchanged source media hashes", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-media-intact-"));
  const sourcePath = join(directory, "project.fcpxml");
  const mediaPath = join(directory, "clip.mp4");
  const mediaContent = "approved media bytes";
  await writeFile(mediaPath, mediaContent);
  const source = `<fcpxml version="1.11"><resources><asset id="r1" name="clip.mp4" src="${pathToFileURL(mediaPath).href}" duration="1s" hasVideo="1" /></resources><library><event><project uid="media-project" name="Media"><sequence uid="media-sequence" name="Main" duration="1s"><spine><asset-clip id="clip" ref="r1" name="clip.mp4" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`;
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;
  const result = await createPublisherForTest({
    enabled: true,
    sourcePath,
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => {
      const imported = liveStateCalls++ > 0;
      return {
        project: { id: imported ? "native-project" : "before-project", name: imported ? "Media" : "Existing" },
        sequence: {
          id: imported ? "native-sequence" : "before-sequence",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
    executor: async () => "imported",
  }).publishNewProject({
    sourceTransactionId: "txn-media-intact",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true, confirmVerification: true,
  });

  assert.deepEqual(result.sourceMediaIntegrity, {
    unchanged: true,
    digests: [{ source: mediaPath, sha256: digest(mediaContent) }],
  });
});

test("FCPXML publisher is unavailable when the production setup cannot bind a created target", () => {
  const publisher = createPublisherForTest({
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
  const publisher = createPublisherForTest({
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
    confirm: true, confirmVerification: true,
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

  const result = await createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  });

  assert.equal(result.createdTarget.projectId, "imported-project");
  assert.equal(result.createdTarget.sequenceId, "imported-sequence");
  assert.equal(stateIndex, 5);
});

test("FCPXML publisher retries transient live-state errors", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-transient-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;

  const result = await createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  });

  assert.equal(result.createdTarget.projectId, "imported-project");
  assert.equal(result.createdTarget.sequenceId, "imported-sequence");
  assert.equal(liveStateCalls, 5);
});

test("FCPXML publisher rejects invalid artifacts before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-invalid-"));
  const sourcePath = join(directory, "invalid.fcpxml");
  await writeFile(sourcePath, "not fcpxml");
  let called = false;
  const publisher = createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  }), /PUBLISH_VALIDATION_FAILED/);
  assert.equal(called, false);
});

test("FCPXML publisher requires explicit confirmation before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-confirmation-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  let called = false;
  const publisher = createPublisherForTest({
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
  const publisher = createPublisherForTest({
    sourcePath: "/tmp/project.fcpxml",
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-disabled",
    artifactPath: "/tmp/project.fcpxml",
    artifactDigest: "unused",
    confirm: true, confirmVerification: true,
  }), /FRAMEKIT_EDITOR.*FRAMEKIT_FCPXML_PATH.*FRAMEKIT_FINAL_CUT_SOCKET/);
});

test("FCPXML publisher rejects an artifact path outside its managed source", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-target-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  let called = false;
  const publisher = createPublisherForTest({
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
    confirm: true, confirmVerification: true,
  }), /PUBLISH_TARGET_MISMATCH/);
  assert.equal(called, false);
});

test("FCPXML publisher prepares a headed-only handoff without opening Final Cut", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-job-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-job" name="Publish Job"><sequence uid="sequence-job" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;

  const job = await createPublisherForTest({
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
  const publisher = createPublisherForTest({
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
  const publisher = createPublisherForTest({
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

  const dispatched = await publisher.executePublishJob(prepared.jobId, true);
  assert.equal(dispatched.state, "verification-pending");
  const verified = await publisher.executePublishJob(prepared.jobId, true, true);

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
  assert.equal(liveStateCalls, 4);
});

test("FCPXML publish jobs resume verification without importing twice", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-resume-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-resume" name="Resume Publish"><sequence uid="sequence-resume" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalls = 0;
  let liveStateCalls = 0;
  const publisher = createPublisherForTest({
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

  const dispatched = await publisher.executePublishJob(prepared.jobId, true);
  assert.equal(dispatched.nextAction, "confirm-verification");
  const pending = await publisher.executePublishJob(prepared.jobId, true, true);

  assert.equal(pending.state, "verification-pending");
  assert.equal(pending.nextAction, "retry");
  assert.equal(pending.retryable, true);
  assert.equal(pending.createdTarget, undefined);
  assert.match(pending.error?.code ?? "", /FINAL_CUT_PUBLISH_STATE_UNAVAILABLE/);

  const resumed = await publisher.executePublishJob(prepared.jobId, true, true);

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
  assert.equal(liveStateCalls, 5);
});

test("FCPXML publish jobs resume verification after publisher restart", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-restart-resume-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "New Library.fcpbundle");
  const publishJobsDirectory = join(directory, "publish-jobs");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-restart" name="Restart Publish"><sequence uid="sequence-restart" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let deliveryCalls = 0;
  let persistedJobId = "";
  const beforeState: EditorLiveState = {
    project: { id: "project-before", name: "Existing" },
    sequence: {
      id: "sequence-before",
      name: "Existing",
      startTime: { value: "0", timescale: "1" },
      duration: { value: "10", timescale: "1" },
      frameDuration: { value: "1", timescale: "24" },
    },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" } },
    revision: { id: "revision-before", sequence: 1, timestamp: new Date(0).toISOString() },
  };
  const createdState: EditorLiveState = {
    project: { id: "project-created", name: "Restart Publish" },
    sequence: {
      id: "sequence-created",
      name: "Main",
      startTime: { value: "0", timescale: "1" },
      duration: { value: "10", timescale: "1" },
      frameDuration: { value: "1", timescale: "24" },
    },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" } },
    revision: { id: "revision-created", sequence: 2, timestamp: new Date(1).toISOString() },
  };
  const publisherOptions = {
    enabled: true,
    sourcePath,
    publishJobsDirectory,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    documentDelivery: {
      deliverFcpxml: async ({ targetLibraryLocation, activates }: { targetLibraryLocation?: string; activates: boolean }) => {
        deliveryCalls += 1;
        const persisted = JSON.parse(await readFile(join(publishJobsDirectory, `${persistedJobId}.json`), "utf8")) as {
          runtime: { importAttempted: boolean; targetLibraryPath: string; reservationId?: string };
        };
        assert.equal(persisted.runtime.importAttempted, true, "the no-repeat marker must be durable before native dispatch");
        assert.equal(persisted.runtime.targetLibraryPath, targetLibraryPath);
        assert.ok(persisted.runtime.reservationId);
        assert.equal(targetLibraryLocation, targetLibraryPath);
        assert.equal(activates, false);
        return {
          status: "dispatched" as const,
          route: "background-document-open" as const,
          attempted: true,
          imported: false,
          requestedActivates: false,
          activation: "preserved" as const,
          ui: "unknown" as const,
          target: { requestedLibraryLocation: targetLibraryPath, guarantee: "requested-unverified" as const },
        };
      },
    },
    targetBinding: async () => ({
      projectId: "project-created",
      sequenceId: "sequence-created",
      libraryId: "library-created",
      eventId: "event-created",
      libraryPath: targetLibraryPath,
    }),
  };
  const firstPublisher = createPublisherForTest({
    ...publisherOptions,
    liveState: async () => beforeState,
  });
  const prepared = await firstPublisher.preparePublish({
    sourceTransactionId: "txn-restart-resume",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  });
  persistedJobId = prepared.jobId;

  const pending = await firstPublisher.executePublishJob(prepared.jobId, true);

  assert.equal(pending.state, "verification-pending");
  assert.equal(pending.delivery?.status, "dispatched");
  assert.equal(pending.delivery?.target.guarantee, "requested-unverified");
  assert.equal(pending.createdTarget, undefined);
  assert.equal(pending.result, undefined);
  assert.equal(deliveryCalls, 1);
  const disabledPublisher = createPublisherForTest({
    ...publisherOptions,
    enabled: false,
    liveState: async () => createdState,
  });
  const unavailable = await disabledPublisher.executePublishJob(prepared.jobId, true, true);
  assert.equal(unavailable.state, "verification-pending", "provider loss must retain the spent import state");
  assert.equal(deliveryCalls, 1);
  const missingLivePublisher = createPublisherForTest({ ...publisherOptions });
  const missingLive = await missingLivePublisher.executePublishJob(prepared.jobId, true, true);
  assert.equal(missingLive.state, "verification-pending", "missing live state must not re-arm dispatch");
  assert.equal(deliveryCalls, 1);
  const restartedPublisher = createPublisherForTest({
    ...publisherOptions,
    liveState: async () => createdState,
  });
  const recovered = restartedPublisher.getPublishJob(prepared.jobId);
  assert.equal(recovered.state, "verification-pending");
  assert.equal(recovered.delivery?.status, "dispatched", "dispatch evidence survives restart");
  assert.equal(recovered.createdTarget, undefined);

  const resumed = await restartedPublisher.executePublishJob(prepared.jobId, true, true);

  assert.equal(resumed.state, "verified");
  assert.deepEqual(resumed.createdTarget, {
    kind: "editor.project",
    projectId: "project-created",
    sequenceId: "sequence-created",
    libraryId: "library-created",
    eventId: "event-created",
    libraryPath: targetLibraryPath,
    projectName: "Restart Publish",
    sequenceName: "Main",
  });
  assert.equal(deliveryCalls, 1, "restart recovery must not dispatch a second import");
  assert.equal(restartedPublisher.getPublishJob(prepared.jobId).state, "verified");
});

async function createCheckpointFailureFixture(prefix: string) {
  const directory = await mkdtemp(join(os.tmpdir(), prefix));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "New Library.fcpbundle");
  const publishJobsDirectory = join(directory, "publish-jobs");
  const source = '<fcpxml version="1.11"><library><event><project uid="checkpoint-project" name="Checkpoint Project"><sequence uid="checkpoint-sequence" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let deliveryCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    publishJobsDirectory,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    documentDelivery: {
      deliverFcpxml: async () => {
        deliveryCalls += 1;
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
      projectId: "checkpoint-project",
      sequenceId: "checkpoint-sequence",
      libraryId: "checkpoint-library",
      eventId: "checkpoint-event",
      libraryPath: targetLibraryPath,
    }),
    liveState: async () => ({
      project: deliveryCalls === 0
        ? { id: "before-project", name: "Existing" }
        : { id: "checkpoint-project", name: "Checkpoint Project" },
      sequence: deliveryCalls === 0
        ? { id: "before-sequence", name: "Existing", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } }
        : { id: "checkpoint-sequence", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: `revision-${deliveryCalls}`, sequence: deliveryCalls, timestamp: new Date(0).toISOString() },
    }),
  });
  const job = await publisher.preparePublish({
    sourceTransactionId: "txn-checkpoint-failure",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  });
  return {
    directory,
    publishJobsDirectory,
    publisher,
    job,
    deliveryCalls: () => deliveryCalls,
  };
}

test("publish job state rolls back when its pre-import checkpoint fails", async () => {
  const fixture = await createCheckpointFailureFixture("framekit-publisher-checkpoint-rollback-");
  const internals = fixture.publisher as unknown as { publishJobsDirectory: string };
  const invalidParent = join(fixture.directory, "not-a-directory");
  await writeFile(invalidParent, "file blocks the publish-job directory");
  const originalDirectory = internals.publishJobsDirectory;
  internals.publishJobsDirectory = join(invalidParent, "publish-jobs");

  await assert.rejects(fixture.publisher.executePublishJob(fixture.job.jobId, true), /ENOTDIR|not a directory/i);
  assert.equal(fixture.publisher.getPublishJob(fixture.job.jobId).state, "awaiting-confirmation");
  assert.equal(fixture.deliveryCalls(), 0);

  internals.publishJobsDirectory = originalDirectory;
  const dispatched = await fixture.publisher.executePublishJob(fixture.job.jobId, true);
  assert.equal(dispatched.state, "verification-pending");
  const verified = await fixture.publisher.executePublishJob(fixture.job.jobId, true, true);
  assert.equal(verified.state, "verified");
  assert.equal(fixture.deliveryCalls(), 1);
});

test("publish retries when the pre-dispatch import marker cannot persist", async () => {
  const fixture = await createCheckpointFailureFixture("framekit-publisher-marker-rollback-");
  const internals = fixture.publisher as unknown as {
    persistPublishJob(job: unknown): void;
  };
  const originalPersist = internals.persistPublishJob.bind(fixture.publisher);
  let persistCalls = 0;
  internals.persistPublishJob = (job) => {
    persistCalls += 1;
    if (persistCalls === 2) throw new Error("simulated checkpoint write failure");
    originalPersist(job);
  };

  const pending = await fixture.publisher.executePublishJob(fixture.job.jobId, true);
  assert.equal(pending.state, "awaiting-final-cut");
  assert.equal(fixture.deliveryCalls(), 0);
  const persisted = JSON.parse(await readFile(join(fixture.publishJobsDirectory, `${fixture.job.jobId}.json`), "utf8")) as {
    runtime?: { importAttempted?: boolean };
  };
  assert.equal(persisted.runtime?.importAttempted, false);

  internals.persistPublishJob = originalPersist;
  const dispatched = await fixture.publisher.executePublishJob(fixture.job.jobId, true);
  assert.equal(dispatched.state, "verification-pending");
  const verified = await fixture.publisher.executePublishJob(fixture.job.jobId, true, true);
  assert.equal(verified.state, "verified");
  assert.equal(fixture.deliveryCalls(), 1);
});

test("FCPXML publish jobs do not report success when the native timeline differs", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-semantic-mismatch-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-mismatch" name="Mismatch Publish"><sequence uid="sequence-mismatch" name="Main" duration="2s"><spine><gap name="Black" offset="0s" duration="2s" /></spine></sequence></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalls = 0;
  let liveStateCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence" }),
    liveState: async () => {
      const imported = liveStateCalls++ > 0;
      return {
        project: { id: imported ? "native-project" : "before-project", name: imported ? "Mismatch Publish" : "Existing" },
        sequence: {
          id: imported ? "native-sequence" : "before-sequence",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "2", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
    executor: async () => {
      executorCalls += 1;
      return "imported";
    },
    readCanonicalSnapshot: async () => {
      const actual = await new FcpxmlDocumentAdapter(sourcePath, undefined, {
        allowMissingImmutableIdsForReadback: true,
      }).readProject();
      actual.timeline.durationTime = { value: "3", timescale: "1" };
      actual.timeline.duration = 3;
      return actual;
    },
  });
  const prepared = await publisher.preparePublish({
    sourceTransactionId: "txn-semantic-mismatch",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  await publisher.executePublishJob(prepared.jobId, true);
  const result = await publisher.executePublishJob(prepared.jobId, true, true);

  assert.equal(result.state, "verification-pending");
  assert.equal(result.createdTarget, undefined);
  assert.equal(result.observedTarget?.projectId, "native-project");
  assert.equal(result.observedTarget?.sequenceId, "native-sequence");
  assert.equal(result.result, undefined);
  assert.equal(result.error?.code, "FINAL_CUT_PUBLISH_SEMANTIC_MISMATCH");
  assert.equal(executorCalls, 1);
});

test("FCPXML publish jobs recheck the source digest before execution", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-digest-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="project-digest" name="Digest Publish"><sequence uid="sequence-digest" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = createPublisherForTest({
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
  const publisher = createPublisherForTest({
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

test("headless FCPXML destination UIDs cannot substitute for native target binding", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-headless-binding-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="fcpxml-project" name="Headless Publish"><sequence uid="fcpxml-sequence" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    headlessSourceVerifier: async () => ({
      targetLibraryUid: "library-1",
      sourceMediaDigests: [],
    }),
    liveState: async () => ({
      project: { id: "existing-project", name: "Existing" },
      sequence: { id: "existing-sequence", name: "Existing", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: "before-revision", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
    executor: async () => {
      executorCalled = true;
      return "unexpected";
    },
  });

  const job = await publisher.preparePublish({
    sourceTransactionId: "headless-rough-cut:execution-1",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath: join(directory, "Target.fcpbundle"),
  });
  await publisher.executePublishJob(job.jobId, true);
  const result = await publisher.executePublishJob(job.jobId, true, true);

  assert.equal("targetBinding" in job, false);
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE");
  assert.equal(executorCalled, false);
});

test("headless library UID may differ from a new native library identity", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-headless-library-identity-"));
  const sourcePath = join(directory, "project.fcpxml");
  const targetLibraryPath = join(directory, "New Native Library.fcpbundle");
  const source = '<fcpxml version="1.11"><library><event><project uid="fcpxml-project" name="Headless Publish"><sequence uid="fcpxml-sequence" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let executorCalls = 0;
  let liveStateCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    headlessSourceVerifier: async () => ({
      targetLibraryUid: "logical-fcpxml-library-uid",
      sourceMediaDigests: [],
    }),
    targetBinding: async () => ({
      projectId: "native-project",
      sequenceId: "native-sequence",
      libraryId: "generated-native-library-uuid",
      eventId: "native-event",
      libraryPath: targetLibraryPath,
    }),
    liveState: async () => {
      const imported = liveStateCalls++ > 0;
      return {
        project: { id: imported ? "native-project" : "existing-project", name: imported ? "Headless Publish" : "Existing" },
        sequence: {
          id: imported ? "native-sequence" : "existing-sequence",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
    executor: async () => {
      executorCalls += 1;
      return "opened";
    },
  });
  const job = await publisher.preparePublish({
    sourceTransactionId: "headless-rough-cut:execution-1",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  });

  await publisher.executePublishJob(job.jobId, true);
  const result = await publisher.executePublishJob(job.jobId, true, true);

  assert.equal(result.state, "verified");
  assert.equal(result.createdTarget?.libraryId, "generated-native-library-uuid");
  assert.equal(result.createdTarget?.projectId, "native-project");
  assert.equal(result.createdTarget?.sequenceId, "native-sequence");
  assert.deepEqual(result.result?.activeProject, {
    before: { id: "existing-project", name: "Existing" },
    after: { id: "native-project", name: "Headless Publish" },
    changed: true,
  });
  assert.equal(executorCalls, 1);
});

test("headless publish rejects media that differs from its approved source digest", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-headless-media-"));
  const sourcePath = join(directory, "project.fcpxml");
  const mediaPath = join(directory, "clip.mp4");
  const mediaContent = "current media bytes";
  await writeFile(mediaPath, mediaContent);
  const source = `<fcpxml version="1.11"><resources><asset id="r1" name="clip.mp4" src="${pathToFileURL(mediaPath).href}" duration="1s" hasVideo="1" /></resources><library><event><project uid="fcpxml-project" name="Headless Publish"><sequence uid="fcpxml-sequence" name="Main" duration="1s"><spine><asset-clip id="clip" ref="r1" name="clip.mp4" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`;
  await writeFile(sourcePath, source);
  let executorCalled = false;
  const targetLibraryPath = join(directory, "Target.fcpbundle");
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    targetBinding: async () => ({ projectId: "native-project", sequenceId: "native-sequence", libraryId: "library-1", libraryPath: targetLibraryPath }),
    headlessSourceVerifier: async () => ({
      targetLibraryUid: "library-1",
      sourceMediaDigests: [{ source: mediaPath, sha256: digest("approved original bytes") }],
    }),
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
  const job = await publisher.preparePublish({
    sourceTransactionId: "headless-rough-cut:execution-1",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    targetLibraryPath,
  });

  const result = await publisher.executePublishJob(job.jobId, true);

  assert.equal(result.state, "awaiting-final-cut");
  assert.equal(result.error?.code, "HEADLESS_ROUGH_CUT_SOURCE_MEDIA_CHANGED");
  assert.equal(executorCalled, false);
});

test("native publish verifies copied media against approved source digests", async () => {
  const publishWithCopy = async (copyContent: string) => {
    const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-native-media-"));
    const sourcePath = join(directory, "project.fcpxml");
    const sourceMediaPath = join(directory, "source", "clip.mp4");
    const nativeMediaPath = join(directory, "native-original-media", "clip.mp4");
    const targetLibraryPath = join(directory, "Target.fcpbundle");
    const sourceBytes = "approved clip bytes";
    await mkdir(dirname(sourceMediaPath), { recursive: true });
    await mkdir(dirname(nativeMediaPath), { recursive: true });
    await writeFile(sourceMediaPath, sourceBytes);
    await writeFile(nativeMediaPath, copyContent);
    const source = `<fcpxml version="1.11"><resources><asset id="r1" name="clip.mp4" src="${pathToFileURL(sourceMediaPath).href}" duration="1s" hasVideo="1" /></resources><library><event><project uid="native-media-project" name="Native Media"><sequence uid="native-media-sequence" name="Main" duration="1s"><spine><asset-clip id="clip" ref="r1" name="clip.mp4" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`;
    await writeFile(sourcePath, source);
    const importedSnapshot = await new FcpxmlDocumentAdapter(sourcePath, undefined, {
      allowMissingImmutableIdsForReadback: true,
    }).readProject();
    importedSnapshot.media[0]!.source = nativeMediaPath;
    let liveStateCalls = 0;
    let executorCalls = 0;
    const publisher = createPublisherForTest({
      enabled: true,
      sourcePath,
      verificationTimeoutMs: 0,
      pollIntervalMs: 0,
      headlessSourceVerifier: async () => ({
        targetLibraryUid: "logical-library",
        sourceMediaDigests: [{ source: sourceMediaPath, sha256: digest(sourceBytes) }],
      }),
      targetBinding: async () => ({
        projectId: "native-project",
        sequenceId: "native-sequence",
        libraryId: "native-library",
        libraryPath: targetLibraryPath,
      }),
      liveState: async () => {
        const imported = liveStateCalls++ > 0;
        return {
          project: { id: imported ? "native-project" : "before-project", name: "Native Media" },
          sequence: {
            id: imported ? "native-sequence" : "before-sequence",
            name: imported ? "Main" : "Existing",
            startTime: { value: "0", timescale: "1" },
            duration: { value: "1", timescale: "1" },
            frameDuration: { value: "1", timescale: "24" },
          },
          revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
        };
      },
      executor: async () => {
        executorCalls += 1;
        return "imported";
      },
      readCanonicalSnapshot: async () => structuredClone(importedSnapshot),
    });
    const prepared = await publisher.preparePublish({
      sourceTransactionId: "headless-rough-cut:native-media",
      artifactPath: sourcePath,
      artifactDigest: digest(source),
      targetLibraryPath,
    });
    await publisher.executePublishJob(prepared.jobId, true);
    const result = await publisher.executePublishJob(prepared.jobId, true, true);
    assert.equal(executorCalls, 1);
    await rm(directory, { recursive: true, force: true });
    return result;
  };

  const verified = await publishWithCopy("approved clip bytes");
  assert.equal(verified.state, "verified");
  assert.equal(verified.result?.sourceMediaIntegrity.unchanged, true);

  const changed = await publishWithCopy("different copied bytes");
  assert.equal(changed.state, "verification-pending");
  assert.equal(changed.error?.code, "FINAL_CUT_PUBLISH_SOURCE_MEDIA_BINDING_MISMATCH");
});

test("FCPXML publisher rejects native IDs that disagree with catalog readback", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-remapped-target-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Remapped Publish"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let liveStateCalls = 0;
  let executorCalls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    targetBinding: async () => ({ projectId: "reserved-project", sequenceId: "reserved-sequence" }),
    executor: async () => {
      executorCalls += 1;
      return "imported";
    },
    liveState: async () => {
      liveStateCalls += 1;
      const imported = liveStateCalls > 1;
      return {
        project: { id: imported ? "remapped-project" : "existing-project", name: imported ? "Remapped Publish" : "Existing" },
        sequence: {
          id: imported ? "remapped-sequence" : "existing-sequence",
          name: imported ? "Main" : "Existing",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateCalls}`, sequence: liveStateCalls, timestamp: new Date(0).toISOString() },
      };
    },
  });
  const job = await publisher.preparePublish({
    sourceTransactionId: "txn-remapped-target",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
  });

  await publisher.executePublishJob(job.jobId, true);
  const result = await publisher.executePublishJob(job.jobId, true, true);

  assert.equal(result.state, "verification-pending");
  assert.equal(result.error?.code, "FINAL_CUT_PUBLISH_TARGET_MISMATCH");
  assert.equal(result.result, undefined);
  assert.equal(executorCalls, 1);
});

test("dispatch and headed readback require separate confirmations", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-separated-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="p" name="Separate"><sequence uid="s" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  let deliveries = 0;
  let readbacks = 0;
  const publisher = new FinalCutProjectPublisher({
    enabled: true, sourcePath, verificationTimeoutMs: 0, pollIntervalMs: 0,
    executor: async () => { deliveries++; return "dispatched"; },
    targetBinding: async () => ({ projectId: "created", sequenceId: "created-sequence" }),
    liveState: async () => ({
      project: deliveries ? { id: "created", name: "Separate" } : { id: "before", name: "Before" },
      sequence: deliveries
        ? { id: "created-sequence", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } }
        : { id: "before-sequence", name: "Before", startTime: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      revision: { id: `revision-${deliveries}`, sequence: deliveries, timestamp: new Date(0).toISOString() },
    }),
    readCanonicalSnapshot: async () => {
      readbacks++;
      return new FcpxmlDocumentAdapter(sourcePath, undefined, { allowMissingImmutableIdsForReadback: true }).readProject();
    },
  });
  const job = await publisher.preparePublish({ sourceTransactionId: "separate", artifactPath: sourcePath, artifactDigest: digest(source) });
  const dispatched = await publisher.executePublishJob(job.jobId, true);
  assert.equal(dispatched.state, "verification-pending");
  assert.equal(deliveries, 1);
  assert.equal(readbacks, 0, "dispatch confirmation cannot authorize headed readback");
  const stillPending = await publisher.executePublishJob(job.jobId, true);
  assert.equal(stillPending.state, "verification-pending");
  assert.equal(readbacks, 0);
  const verified = await publisher.executePublishJob(job.jobId, true, true);
  assert.equal(verified.state, "verified");
  assert.equal(readbacks, 1);
  assert.equal(deliveries, 1);
});

test("direct publish refuses import without explicit readback authorization", async () => {
  let calls = 0;
  const publisher = createPublisherForTest({
    enabled: true,
    sourcePath: "/nonexistent/artifact.fcpxml",
    executor: async () => { calls++; return ""; },
  });
  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn", artifactPath: "/nonexistent/artifact.fcpxml",
    artifactDigest: "digest", confirm: true,
  }), /PUBLISH_VERIFICATION_CONFIRMATION_REQUIRED/);
  assert.equal(calls, 0);
});

test("a spent import reservation survives publisher death and prevents another dispatch", async () => {
  const fixture = await createCheckpointFailureFixture("framekit-publisher-spent-reservation-");
  const first = await fixture.publisher.executePublishJob(fixture.job.jobId, true);
  assert.equal(first.state, "verification-pending");
  assert.equal(fixture.deliveryCalls(), 1);
  assert.ok(fixture.job.targetLibraryPath);
  const reservationPath = await reservationPathFor(fixture.job.targetLibraryPath);
  const reservation = JSON.parse(await readFile(reservationPath, "utf8"));
  await writeFile(reservationPath, JSON.stringify({ ...reservation, pid: 2147483647 }));
  const second = await fixture.publisher.preparePublish({
    sourceTransactionId: fixture.job.sourceTransactionId,
    artifactPath: fixture.job.sourcePath,
    artifactDigest: fixture.job.artifactDigest,
    targetLibraryPath: fixture.job.targetLibraryPath,
  });
  const rejected = await fixture.publisher.executePublishJob(second.jobId, true);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.error?.code, "PUBLISH_TARGET_LIBRARY_RESERVED");
  assert.equal(fixture.deliveryCalls(), 1);
});
