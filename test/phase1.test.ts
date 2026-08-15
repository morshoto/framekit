import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryEditorAdapter } from "../src/adapters/in-memory-editor.js";
import { FinalCutAdapter } from "../src/adapters/final-cut.js";
import { FinalCutLiveAdapter, type FinalCutLiveRequest, type FinalCutLiveResponse } from "../src/adapters/final-cut-live.js";
import { FixtureAudioAnalyzer, FixtureSpeechAnalyzer } from "../src/analyzers/fixture.js";
import { AgentVideoRuntime } from "../src/core/runtime.js";
import type { FinalCutLiveChange, FinalCutLiveState } from "../src/core/types.js";

class FakeFinalCutLiveTransport {
  public readonly requests: FinalCutLiveRequest[] = [];
  private readonly state: FinalCutLiveState = {
    project: { id: "project-live-1", name: "Playhead Phase 1 E2E" },
    sequence: {
      id: "sequence-live-1",
      name: "Playhead Phase 1 E2E",
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
    const identity = { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" };
    const capabilities = {
      projectRead: true,
      timelineRead: false,
      timelineWrite: false,
      readAfterWrite: false,
      incrementalChanges: true,
      speechAnalysis: false,
      audioAnalysis: false,
      rollback: false,
      visualAnalysis: false,
      assetDiscovery: false,
      liveSelection: true,
      livePlayhead: true,
      playbackControl: false,
    };
    if (request.method === "capabilities") return { version: 1, id: request.id, ok: true, result: { identity, capabilities } };
    if (request.method === "state") return { version: 1, id: request.id, ok: true, result: { identity, capabilities, state: this.state } };
    const change: FinalCutLiveChange = {
      kind: "playhead-changed",
      revision: this.state.revision,
      state: this.state,
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
  const directory = await mkdtemp(join(os.tmpdir(), "playhead-fcpxml-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources><asset id="r1" name="Interview.wav" src="file:///Interview.wav" /></resources>
  <library><event name="Event"><project name="Phase 1 Fixture"><sequence duration="10s"><spine>
    <asset-clip ref="r1" name="Interview" offset="0s" start="0s" duration="1001/24000s" lane="1" />
  </spine></sequence></project></event></library>
</fcpxml>`);

  const adapter = new FinalCutAdapter(path);
  const identity = await adapter.getIdentity();
  const capabilities = await adapter.getCapabilities();
  const before = await adapter.readProject();
  assert.equal(identity.name, "Final Cut Pro");
  assert.equal(capabilities.timelineWrite, true);
  assert.equal(before.timeline.clips[0]?.name, "Interview");
  assert.deepEqual(before.timeline.clips[0]?.durationTime, { value: "1001", timescale: "24000" });

  await adapter.apply({ type: "rename-clip", clipId: "r1", name: "Interview - Clean" }, before.revision);
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

  await adapter.apply({ type: "trim-clip", clipId: "r1", duration: 5 }, marked.revision);
  const trimmed = await adapter.readProject();
  assert.equal(trimmed.timeline.clips[0]?.duration, 5);
  await adapter.apply({ type: "set-gain", clipId: "r1", gainDb: 2 }, trimmed.revision);
  const gained = await adapter.readProject();
  assert.equal(gained.timeline.clips[0]?.gainDb, 2);
  await adapter.apply({
    type: "ripple-delete",
    timelineId: gained.timeline.id,
    range: { start: 2, end: 3 },
  }, gained.revision);
  assert.equal((await adapter.readProject()).timeline.clips[0]?.duration, 4);
});

test("Final Cut adapter turns external FCPXML edits into a new revision", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "playhead-fcpxml-external-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml><resources/><library><event><project name="External"><sequence duration="2s"><spine><asset-clip ref="r1" name="Original" offset="0s" duration="2s" /></spine></sequence></project></event></library></fcpxml>`);
  const adapter = new FinalCutAdapter(path);
  const before = await adapter.readProject();
  await writeFile(path, (await readFile(path, "utf8")).replace("Original", "External Edit"));
  const after = await adapter.readProject();
  assert.equal(after.revision.sequence, before.revision.sequence + 1);
  assert.equal(after.timeline.clips[0]?.name, "External Edit");
  await assert.rejects(
    adapter.apply({ type: "rename-clip", clipId: "r1", name: "Stale Write" }, before.revision),
    /STALE_CONTEXT/,
  );
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
  assert.equal(state.project?.name, "Playhead Phase 1 E2E");
  assert.deepEqual(state.playheadTime, { value: "1001", timescale: "24000" });
  assert.equal((await adapter.getCapabilities()).timelineRead, false);
  assert.equal((await adapter.liveChangesSince({ id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() })).length, 1);
  await assert.rejects(adapter.readProject(), /CAPABILITY_UNAVAILABLE/);
  await assert.rejects(adapter.apply({ type: "rename-clip", clipId: "clip-1", name: "Nope" }, state.revision), /CAPABILITY_UNAVAILABLE/);
  assert.deepEqual(transport.requests.map(({ method }) => method), ["state", "capabilities", "changes"]);
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
