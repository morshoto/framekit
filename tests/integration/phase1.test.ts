import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryEditorAdapter, FixtureAudioAnalyzer, FixtureSpeechAnalyzer } from "@framekit/testkit";
import { FcpxmlDocumentAdapter, FinalCutLiveAdapter, FinalCutSessionAdapter, type FinalCutLiveRequest, type FinalCutLiveResponse } from "@framekit/final-cut";
import { AgentVideoRuntime, type EditorChange, type EditorLiveState } from "@framekit/runtime";

class FakeFinalCutLiveTransport {
  public constructor(private readonly invalidState = false) {}

  public readonly requests: FinalCutLiveRequest[] = [];
  private readonly state: EditorLiveState = {
    project: { id: "project-live-1", name: "Framekit Phase 1 E2E" },
    sequence: {
      id: "sequence-live-1",
      name: "Framekit Phase 1 E2E",
      startTime: { value: "0", timescale: "24000" },
      duration: { value: "240000", timescale: "24000" },
      frameDuration: { value: "1001", timescale: "24000" },
    },
    playheadTime: { value: "1001", timescale: "24000" },
    sequenceTimeRange: {
      start: { value: "0", timescale: "24000" },
      duration: { value: "240000", timescale: "24000" },
    },
    revision: { id: "rev-2", sequence: 2, timestamp: new Date(2).toISOString() },
  };

  public async request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> {
    this.requests.push(request);
    const state = this.invalidState
      ? { ...this.state, playheadTime: { value: "0", timescale: "0" } }
      : this.state;
    const identity = { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" };
    const capabilities = {
      editor: {
        projectRead: true,
        timelineSnapshotRead: false,
        timelineWrite: false,
        timelineArtifactWrite: false,
        readAfterWrite: false,
        incrementalChanges: true,
        rollback: false,
        assetDiscovery: false,
        liveStateRead: true,
        playheadWrite: false,
        frameCapture: false,
        playbackControl: false,
      },
      analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
    };
    if (request.method === "capabilities") return { version: 1, id: request.id, ok: true, result: { identity, capabilities } };
    if (request.method === "state") return { version: 1, id: request.id, ok: true, result: { identity, capabilities, state } };
    const change: EditorChange = {
      kind: "playhead-changed",
      revision: state.revision,
      state,
    };
    return { version: 1, id: request.id, ok: true, result: { identity, capabilities, changes: request.afterSequence === 2 ? [] : [change] } };
  }
}

function fixtureAdapter() {
  return new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Phase 1 Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [
      { id: "clip-1", mediaId: "media-1", name: "Interview", start: 0, duration: 10, track: 1 },
    ],
    media: [{
      mediaId: "media-1",
      source: "interview.wav",
      speech: {
        words: [
          { text: "So", start: 0, end: 0.3, confidence: 0.99 },
          { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
          { text: "hello", start: 0.8, end: 1.2, confidence: 0.99 },
        ],
      },
      audio: { integratedLufs: -18, truePeakDb: -3, silenceMs: 120 },
    }],
  });
}

test("Final Cut adapter reads and writes a supported FCPXML timeline", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources><asset id="r1" name="Interview.wav" src="file:///Interview.wav" /></resources>
  <library><event name="Event"><project name="Phase 1 Fixture" uid="project-phase-1"><sequence uid="sequence-phase-1" duration="10s"><spine>
    <asset-clip ref="r1" name="Interview" offset="0s" start="0s" duration="1001/24000s" lane="1" />
  </spine></sequence></project></event></library>
</fcpxml>`);

  const adapter = new FcpxmlDocumentAdapter(path);
  const identity = await adapter.getIdentity();
  const capabilities = await adapter.getCapabilities();
  const before = await adapter.readProject();
  const catalog = await adapter.listProjects();
  assert.equal(identity.name, "Final Cut Pro");
  assert.equal(capabilities.editor.timelineArtifactWrite, true);
  assert.equal(catalog.projects[0]?.id, before.projectId);
  assert.equal(catalog.projects[0]?.sequences[0]?.id, before.timeline.id);
  assert.equal(before.timeline.clips[0]?.name, "Interview");
  assert.deepEqual(before.timeline.clips[0]?.durationTime, { value: "1001", timescale: "24000" });

  const clipId = before.timeline.clips[0]!.id;
  await adapter.apply({ type: "rename-clip", clipId, name: "Interview - Clean" }, before.revision);
  const after = await adapter.readProject();
  assert.equal(after.timeline.clips[0]?.name, "Interview - Clean");
  assert.deepEqual(after.timeline.clips[0]?.durationTime, { value: "1001", timescale: "24000" });
  assert.match(await readFile(path, "utf8"), /name="Interview - Clean"/);
  assert.match(await readFile(path, "utf8"), /duration="1001\/24000s"/);

  await adapter.apply({
    type: "add-marker",
    timelineId: before.timeline.id,
    marker: { id: "marker-1", start: 2, duration: 0, name: "Review" },
  }, after.revision);
  const marked = await adapter.readProject();
  assert.equal(marked.timeline.markers[0]?.name, "Review");

  await adapter.apply({ type: "trim-clip", clipId, duration: 5 }, marked.revision);
  const trimmed = await adapter.readProject();
  assert.equal(trimmed.timeline.clips[0]?.duration, 5);
  await adapter.apply({ type: "set-gain", clipId, gainDb: 2 }, trimmed.revision);
  const gained = await adapter.readProject();
  assert.equal(gained.timeline.clips[0]?.gainDb, 2);
  await assert.rejects(adapter.apply({
    type: "ripple-delete",
    timelineId: gained.timeline.id,
    range: { start: 2, end: 3 },
  }, gained.revision), /CAPABILITY_UNAVAILABLE/);
  assert.match(await readFile(path, "utf8"), /adjust-volume amount="2dB"/);
});

test("FCPXML runtime rolls back an artifact after verification failure", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-rollback-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-rollback" name="Rollback"><sequence uid="sequence-rollback" duration="2s"><spine><asset-clip name="Original" offset="0s" duration="2s" /></spine></sequence></project></event></library></fcpxml>`);

  const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
  const before = await runtime.inspectProject();
  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Must Roll Back" },
    { maxTruePeakDb: -6 },
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.name, "Original");
  assert.match(await readFile(path, "utf8"), /name="Original"/);
});

test("FCPXML project identity fails closed without an immutable uid", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-project-identity-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project name="Mutable Project"><sequence uid="sequence-stable" name="Stable Sequence" duration="1s"><spine><gap duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const adapter = new FcpxmlDocumentAdapter(path);

  await assert.rejects(adapter.listProjects(), /FCPXML_PROJECT_IDENTITY_UNAVAILABLE/);
  await assert.rejects(adapter.readProject(), /FCPXML_PROJECT_IDENTITY_UNAVAILABLE/);
});

test("FCPXML sequence identity fails closed without an immutable uid", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-sequence-identity-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-stable" name="Stable Project"><sequence name="Mutable Sequence" duration="1s"><spine><gap duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const adapter = new FcpxmlDocumentAdapter(path);

  await assert.rejects(adapter.listProjects(), /FCPXML_SEQUENCE_IDENTITY_UNAVAILABLE/);
  await assert.rejects(adapter.readProject(), /FCPXML_SEQUENCE_IDENTITY_UNAVAILABLE/);
});

test("UID-backed FCPXML identities remain stable across project and sequence renames", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-identity-rename-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-stable" name="Before Project"><sequence uid="sequence-stable" name="Before Sequence" duration="1s"><spine><gap duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const adapter = new FcpxmlDocumentAdapter(path);
  const before = await adapter.listProjects();

  await writeFile(path, (await readFile(path, "utf8"))
    .replace("Before Project", "After Project")
    .replace("Before Sequence", "After Sequence"));
  const after = await adapter.listProjects();

  assert.equal(after.activeProjectId, before.activeProjectId);
  assert.equal(after.activeSequenceId, before.activeSequenceId);
});

test("UID-backed same-name FCPXML targets remain distinct", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-identity-collision-"));
  const firstPath = join(directory, "first.fcpxml");
  const secondPath = join(directory, "second.fcpxml");
  const document = (projectUid: string, sequenceUid: string) => `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="${projectUid}" name="Shared Project"><sequence uid="${sequenceUid}" name="Shared Sequence" duration="1s"><spine><gap duration="1s" /></spine></sequence></project></event></library></fcpxml>`;
  await writeFile(firstPath, document("project-first", "sequence-first"));
  await writeFile(secondPath, document("project-second", "sequence-second"));

  const first = await new FcpxmlDocumentAdapter(firstPath).listProjects();
  const second = await new FcpxmlDocumentAdapter(secondPath).listProjects();

  assert.notEqual(first.activeProjectId, second.activeProjectId);
  assert.notEqual(first.activeSequenceId, second.activeSequenceId);
});

test("Final Cut adapter turns external FCPXML edits into a new revision", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-external-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-external" name="External"><sequence uid="sequence-external" duration="2s"><spine><asset-clip ref="r1" name="Original" offset="0s" duration="2s" /></spine></sequence></project></event></library></fcpxml>`);
  const adapter = new FcpxmlDocumentAdapter(path);
  const before = await adapter.readProject();
  await writeFile(path, (await readFile(path, "utf8")).replace("Original", "External Edit"));
  const after = await adapter.readProject();
  assert.equal(after.revision.sequence, before.revision.sequence + 1);
  assert.equal(after.timeline.clips[0]?.name, "External Edit");
  await assert.rejects(
    adapter.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Stale Write" }, before.revision),
    /STALE_CONTEXT/,
  );
});

test("FCPXML preserves heterogeneous spine order and distinct clip occurrences", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-order-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources><asset id="r1" src="file:///interview.mov" /></resources><library><event><project uid="project-ordered" name="Ordered"><sequence uid="sequence-ordered" duration="8s"><spine>
    <asset-clip ref="r1" offset="0s" duration="2s" />
    <gap offset="2s" duration="1s" />
    <title offset="3s" duration="1s" name="Card" />
    <asset-clip ref="r1" offset="4s" duration="2s" />
    <transition offset="6s" duration="1s" />
    <caption id="caption-1" start="6s" duration="1s" text="Hello" />
    <ref-clip ref="r1" offset="7s" duration="1s" />
  </spine></sequence></project></event></library></fcpxml>`);

  const adapter = new FcpxmlDocumentAdapter(path);
  const before = await adapter.readProject();
  assert.deepEqual(before.timeline.storyElements.map((element) => element.kind), [
    "asset-clip", "gap", "title", "asset-clip", "transition", "ref-clip",
  ]);
  assert.equal(before.timeline.clips.length, 3);
  assert.equal(before.timeline.clips[0]?.mediaId, "r1");
  assert.deepEqual(before.timeline.captions, [{
    id: "caption-1",
    start: 6,
    duration: 1,
    startTime: { value: "6", timescale: "1" },
    durationTime: { value: "1", timescale: "1" },
    text: "Hello",
  }]);
  assert.equal(new Set(before.timeline.clips.map((clip) => clip.id)).size, 3);
  assert.deepEqual(before.timeline.clips.map((clip) => clip.mediaId), ["r1", "r1", "r1"]);

  await adapter.apply({ type: "rename-clip", clipId: before.timeline.clips[1]!.id, name: "Second use" }, before.revision);
  const xml = await readFile(path, "utf8");
  assert.ok(xml.indexOf("<gap") < xml.indexOf("<title"));
  assert.ok(xml.indexOf("<title") < xml.indexOf('name="Second use"'));
  assert.ok(xml.indexOf('name="Second use"') < xml.indexOf("<transition"));
});

test("FCPXML preserves connected story elements with exact parent-relative coordinates", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-connected-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources>
    <asset id="r1" src="file:///primary.mov" />
    <asset id="r2" src="file:///connected.mov" />
  </resources><library><event><project uid="project-connected" name="Connected"><sequence uid="sequence-connected" duration="8s"><spine>
    <asset-clip id="primary" ref="r1" offset="1/3s" duration="7s">
      <asset-clip id="connected" ref="r2" offset="2/3s" duration="3s" lane="1" />
      <title id="connected-title" offset="5/3s" duration="1s" lane="2" name="Connected title" />
    </asset-clip>
    <marker id="marker-1" start="7s" duration="0s" value="End" />
  </spine></sequence></project></event></library></fcpxml>`);

  const snapshot = await new FcpxmlDocumentAdapter(path).readProject();

  assert.deepEqual(snapshot.timeline.storyElements.map(({ id, kind, start, duration, lane }) => ({
    id,
    kind,
    start,
    duration,
    lane,
  })), [
    { id: "primary", kind: "asset-clip", start: 1 / 3, duration: 7, lane: undefined },
    { id: "connected", kind: "asset-clip", start: 1, duration: 3, lane: 1 },
    { id: "connected-title", kind: "title", start: 2, duration: 1, lane: 2 },
  ]);
  assert.deepEqual(snapshot.timeline.clips.map(({ id, startTime, durationTime }) => ({ id, startTime, durationTime })), [
    { id: "primary", startTime: { value: "1", timescale: "3" }, durationTime: { value: "7", timescale: "1" } },
    { id: "connected", startTime: { value: "1", timescale: "1" }, durationTime: { value: "3", timescale: "1" } },
  ]);
  assert.deepEqual(snapshot.timeline.storyElements[1]?.startTime, { value: "1", timescale: "1" });
  assert.deepEqual(snapshot.timeline.storyElements[2]?.startTime, { value: "2", timescale: "1" });
});

test("Final Cut session composes document snapshot and live state providers", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-session-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-session" name="Session"><sequence uid="sequence-session" duration="1s"><spine><gap duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const live = new FinalCutLiveAdapter(new FakeFinalCutLiveTransport());
  const session = new FinalCutSessionAdapter({
    snapshot: new FcpxmlDocumentAdapter(path),
    mutation: new FcpxmlDocumentAdapter(path),
    live,
  });
  const capabilities = await session.getCapabilities();
  assert.equal(capabilities.editor.timelineSnapshotRead, true);
  assert.equal(capabilities.editor.timelineArtifactWrite, true);
  assert.equal(capabilities.editor.timelineWrite, false);
  assert.equal(capabilities.editor.liveStateRead, true);
  assert.equal((await session.readLiveState()).project?.name, "Framekit Phase 1 E2E");
  assert.equal((await session.readProject()).projectName, "Session");
});

test("snapshot-only Final Cut sessions advertise and select their project target", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-snapshot-selection-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-snapshot" name="Snapshot Only"><sequence uid="sequence-snapshot" duration="1s"><spine><gap duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const document = new FcpxmlDocumentAdapter(path);
  const session = new FinalCutSessionAdapter({ snapshot: document });
  const capabilities = await session.getCapabilities();
  assert.equal(capabilities.editor.projectSelection, true);
  const catalog = await session.listProjects();
  const selected = await session.selectProject({ projectId: catalog.activeProjectId! });
  assert.equal(selected.activeProjectId, catalog.activeProjectId);
  assert.equal(selected.activeSequenceId, catalog.activeSequenceId);
});

test("Final Cut sessions do not advertise mutation-only project selection", async () => {
  const session = new FinalCutSessionAdapter({ mutation: fixtureAdapter() });
  const capabilities = await session.getCapabilities();
  assert.equal(capabilities.editor.projectSelection, false);
  await assert.rejects(
    new AgentVideoRuntime(session).selectProject({ projectId: "project-1" }),
    /CAPABILITY_UNAVAILABLE: editor project selection/,
  );
});

test("post-write verification invokes analyzers for affected ranges", async () => {
  const editor = fixtureAdapter();
  let speechCalls = 0;
  let audioCalls = 0;
  const runtime = new AgentVideoRuntime(editor, {
    speechAnalyzer: { analyze: async ({ media }) => { speechCalls += 1; return structuredClone(media.speech!); } },
    audioAnalyzer: { analyze: async ({ media }) => { audioCalls += 1; return structuredClone(media.audio!); } },
  });
  const transaction = await runtime.edit({ type: "rename-clip", clipId: "clip-1", name: "Analyzed" });
  assert.equal(transaction.status, "VERIFIED");
  assert.ok(speechCalls > 0);
  assert.ok(audioCalls > 0);
});

test("Phase 1 provides context changes and speech/audio analysis ports", async () => {
  const runtime = new AgentVideoRuntime(fixtureAdapter(), {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: new FixtureAudioAnalyzer(),
  });
  const before = await runtime.inspectProject();
  const speech = await runtime.analyzeSpeech("media-1");
  const audio = await runtime.analyzeAudio("media-1");
  assert.equal(speech.words.find((word) => word.filler)?.text, "um");
  assert.equal(audio.integratedLufs, -18);

  await runtime.edit({ type: "rename-clip", clipId: "clip-1", name: "Clean" });
  const changes = await runtime.changesSince(before.revision);
  assert.equal(changes.modified[0]?.itemId, "clip-1");
});

test("Final Cut live adapter reads native state and incremental events", async () => {
  const transport = new FakeFinalCutLiveTransport();
  const adapter = new FinalCutLiveAdapter(transport);
  const state = await adapter.readLiveState();
  assert.equal(state.project?.name, "Framekit Phase 1 E2E");
  assert.deepEqual(state.playheadTime, { value: "1001", timescale: "24000" });
  assert.equal((await adapter.getCapabilities()).editor.timelineSnapshotRead, false);
  assert.equal((await adapter.liveChangesSince({ id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() })).length, 1);
  assert.deepEqual(transport.requests.map(({ method }) => method), ["state", "capabilities", "changes"]);
});

test("Final Cut live adapter rejects unavailable rational times", async () => {
  const adapter = new FinalCutLiveAdapter(new FakeFinalCutLiveTransport(true));

  await assert.rejects(adapter.readLiveState(), /positive timescale/);
  await assert.rejects(
    adapter.liveChangesSince({ id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() }),
    /positive timescale/,
  );
});

test("Phase 1 verifies successful transactions and supports undo", async () => {
  const runtime = new AgentVideoRuntime(fixtureAdapter());
  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "clip-1", name: "Clean" },
    { requireExpectedChange: true },
  );
  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.verification?.passed, true);

  await runtime.undo(transaction.id);
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.name, "Interview");
});

test("Phase 1 rolls back when a verification policy fails", async () => {
  const runtime = new AgentVideoRuntime(fixtureAdapter());
  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "clip-1", name: "Must Roll Back" },
    { maxTruePeakDb: -6 },
  );
  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.passed, false);
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.name, "Interview");
});

test("Phase 1 protects transcript continuity during a trim", async () => {
  const runtime = new AgentVideoRuntime(fixtureAdapter());
  const transaction = await runtime.edit(
    { type: "trim-clip", clipId: "clip-1", duration: 0.5 },
    { requireSpeechContinuity: true },
  );
  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.checks.some((check) => check.name === "speech-continuity" && !check.passed), true);
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.duration, 10);
});

test("Phase 1 supports ripple delete, markers, and signal verification policies", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Editing Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [
      { id: "clip-1", mediaId: "media-1", name: "Interview", start: 0, duration: 10, track: 1 },
      { id: "clip-2", name: "B-roll", start: 12, duration: 4, track: 1 },
    ],
    media: [{
      mediaId: "media-1",
      source: "interview.wav",
      speech: { words: [{ text: "hello", start: 0, end: 1, confidence: 1 }] },
      audio: { integratedLufs: -16, truePeakDb: -3, silenceMs: 100 },
    }],
    assets: [{ id: "transition-1", kind: "transition", name: "Cross Dissolve", vendor: "Fixture", metadata: {} }],
  }));

  const ripple = await runtime.edit({
    type: "ripple-delete",
    timelineId: "timeline-1",
    range: { start: 4, end: 5 },
  }, { requireExpectedChange: true });
  assert.equal(ripple.status, "VERIFIED");
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.duration, 9);
  assert.equal((await runtime.inspectProject()).timeline.clips[1]?.start, 11);

  const marker = await runtime.edit({
    type: "add-marker",
    timelineId: "timeline-1",
    marker: { id: "marker-1", start: 2, duration: 0, name: "Review" },
  });
  assert.equal(marker.diff.markerChanges[0]?.type, "MARKER_ADDED");
  assert.equal((await runtime.inspectProject()).timeline.markers[0]?.name, "Review");

  const loudness = await runtime.edit({ type: "set-gain", clipId: "clip-1", gainDb: 2 }, {
    targetLufs: -16,
    loudnessToleranceDb: 0.1,
    maxTruePeakDb: -2,
  });
  assert.equal(loudness.status, "VERIFIED");
  assert.equal((await runtime.listAssets())[0]?.name, "Cross Dissolve");
});
