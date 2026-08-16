Software Design Document

Agentic Video Editing Runtime

Version: 0.2
Status: Architecture Draft
Date: August 2026
Initial Target: Final Cut Pro
Architecture: Hexagonal / Ports and Adapters
Runtime: Local-first
Initial Language Direction: TypeScript + Swift
Optional Analyzer Runtimes: Python, Rust, native binaries

⸻

1. Design Objectives

The system must:

1. isolate editor-specific integrations;
2. support multiple NLEs without changing agent logic;
3. operate primarily on the user’s machine;
4. expose semantic operations rather than vendor APIs;
5. support read-after-write synchronization;
6. maintain an incremental editor-state model;
7. expose editor-native effects, transitions, and assets;
8. integrate replaceable media-analysis systems;
9. execute edits transactionally;
10. verify edits before considering them successful;
11. expose the runtime through MCP without coupling the runtime to MCP;
12. support community-defined Skills.

⸻

2. Architecture Overview

┌────────────────────────────────────────────┐
│                 Agent Clients              │
│                                            │
│        Codex      Claude Code      ...     │
└────────────────────┬───────────────────────┘
                     │ MCP
                     ▼
┌────────────────────────────────────────────┐
│                MCP Gateway                 │
│                                            │
│ tool definitions                           │
│ schema validation                          │
│ resource/context exposure                  │
└────────────────────┬───────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│            Agent Video Runtime             │
│                                            │
│ Context Engine                             │
│ Analysis Orchestrator                      │
│ Semantic Edit Engine                       │
│ Transaction Manager                        │
│ Diff Engine                                │
│ Verification Engine                        │
│ Asset Registry                             │
│ Skill Runtime                              │
│ Capability Registry                        │
└──────────┬──────────────────────┬──────────┘
           │                      │
           │ EditorPort           │ AnalyzerPorts
           ▼                      ▼
┌─────────────────────┐   ┌──────────────────────┐
│   Editor Adapters   │   │      Analyzers       │
│                     │   │                      │
│ Final Cut           │   │ ASR                  │
│ Premiere            │   │ VAD                  │
│ Resolve             │   │ Audio                │
└──────────┬──────────┘   │ Scene Detection      │
           │              │ Tracking             │
           ▼              │ Vision               │
┌─────────────────────┐   └──────────────────────┘
│ Integration Backend │
│                     │
│ FCPXML               │
│ Swift/macOS Bridge   │
│ CommandPost          │
│ Premiere APIs        │
│ Resolve APIs         │
└─────────────────────┘

⸻

3. Process Architecture

The initial Final Cut implementation should use separate responsibilities.

Node / TypeScript Runtime
        │
        │ IPC / local RPC
        ▼
Swift macOS Bridge
        │
        ▼
Final Cut / macOS

TypeScript should own:

MCP
domain model
context engine
transactions
diff
verification orchestration
skills
adapter contracts

Swift should own macOS-specific functionality where needed:

Apple Events
Accessibility
Final Cut process integration
native filesystem events
native framework access
local editor observation

Editor-independent logic must not be implemented in Swift merely because Final Cut is the first editor.

⸻

4. Local Deployment Model

The runtime runs locally.

Recommended topology:

User machine
┌─────────────────────────┐
│ Codex / Claude Code     │
└───────────┬─────────────┘
            │ stdio / local MCP
┌───────────▼─────────────┐
│ agent-video-mcp         │
└───────────┬─────────────┘
            │
┌───────────▼─────────────┐
│ agent-video-runtime     │
└───────┬──────────┬──────┘
        │          │
        ▼          ▼
  Final Cut     Analyzers

No public server is necessary for the default configuration.

⸻

5. Package Structure

Recommended monorepo:

agent-video/
│
├── apps/
│   ├── cli/
│   └── mcp-server/
│
├── packages/
│   ├── core/
│   ├── context/
│   ├── timeline/
│   ├── editing/
│   ├── transactions/
│   ├── diff/
│   ├── verification/
│   ├── assets/
│   ├── analyzers/
│   ├── skills/
│   ├── editor-sdk/
│   └── testkit/
│
├── adapters/
│   ├── final-cut/
│   │   ├── typescript/
│   │   └── swift-bridge/
│   ├── premiere/
│   └── resolve/
│
├── analyzer-backends/
│   ├── asr/
│   ├── vad/
│   ├── audio/
│   ├── scene/
│   └── vision/
│
├── skills/
│   ├── filler-removal/
│   ├── dialogue-normalization/
│   └── podcast-cleanup/
│
├── fixtures/
│   ├── final-cut/
│   └── media/
│
└── docs/

⸻

6. Canonical Time Representation

Floating-point seconds must not be used as the authoritative representation.

Recommended:

interface RationalTime {
  value: bigint;
  timescale: bigint;
}

Example:

24000 / 1001 fps

must remain distinguishable from:

24 fps

Conversions should occur only at API boundaries.

⸻

7. Canonical Editorial Model

interface Project {
  id: string;
  name: string;
  timelines: Timeline[];
  activeTimelineId?: string;
}
interface Timeline {
  id: string;
  name: string;
  start: RationalTime;
  duration: RationalTime;
  lanes: TimelineLane[];
  markers: Marker[];
  revision?: string;
}
interface TimelineLane {
  id: string;
  kind:
    | "primary"
    | "video"
    | "audio"
    | "caption"
    | "metadata";
  items: TimelineItem[];
}
type TimelineItem =
  | Clip
  | Gap
  | Transition
  | CompoundItem;
interface Clip {
  id: string;
  mediaId: string;
  timelineRange: TimeRange;
  sourceRange: TimeRange;
  role?: string;
  enabled: boolean;
  effects?: EffectInstance[];
  metadata: Record<string, unknown>;
}

The canonical model must support structures that do not map cleanly to simple track-based editors.

This is especially important for Final Cut connected clips and storyline relationships.

⸻

8. Editor-Specific Metadata

Vendor-specific information may be preserved without leaking into agent semantics.

interface VendorMetadata {
  vendor: string;
  data: unknown;
}

Example:

clip.vendorMetadata = {
  vendor: "final-cut",
  data: {
    storylineId: "...",
    lane: 2
  }
};

The runtime may use this information for round-trip fidelity.

Agents should normally not depend on it.

⸻

9. Agent Context Model

interface AgentContext {
  revision: ContextRevision;
  project: Project;
  editorState: EditorState;
  media: MediaContext[];
  recentChanges: ContextChange[];
  capabilities: RuntimeCapabilities;
}

The context model should be queryable rather than always serialized wholesale.

⸻

10. Context Engine

The Context Engine owns the agent-facing representation of the editing session.

Responsibilities:

initial project snapshot
normalization
analysis attachment
editor state
revision tracking
incremental changes
context queries
cache invalidation

The Context Engine must not assume that every client has enough context window to receive the full project.

⸻

11. Revision Model

Every observable editor state should have a revision.

interface ContextRevision {
  id: string;
  sequence: bigint;
  timestamp: string;
}

Example:

revision 128
    ↓
user trims clip
    ↓
revision 129

The runtime should expose:

getChangesSince(revision: ContextRevision): Promise<ContextDiff>;

⸻

12. Incremental Diff

interface ContextDiff {
  from: ContextRevision;
  to: ContextRevision;
  timelineChanges: TimelineChange[];
  stateChanges: EditorStateChange[];
  assetChanges: AssetChange[];
}

Possible changes:

ITEM_ADDED
ITEM_REMOVED
ITEM_TRIMMED
ITEM_MOVED
PROPERTY_CHANGED
SELECTION_CHANGED
PLAYHEAD_CHANGED
ASSET_ADDED

The agent should be able to request:

what changed since my last observation?

without reloading the entire project.

⸻

13. EditorPort

interface EditorPort {
  getIdentity(): Promise<EditorIdentity>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  readProject(): Promise<ProjectSnapshot>;
  readState(): Promise<EditorState>;
  readChanges?(
    since: EditorRevision
  ): Promise<EditorChangeSet>;
  applyOperations(
    operations: EditOperation[],
    options?: ApplyOptions
  ): Promise<ApplyResult>;
  listAssets?(
    query?: AssetQuery
  ): Promise<EditorAsset[]>;
  renderRange?(
    request: RenderRequest
  ): Promise<RenderedArtifact>;
  undo?(): Promise<void>;
}

⸻

14. Capabilities

Capabilities should be granular.

interface EditorCapabilities {
  projectRead: boolean;
  timelineSnapshotRead: boolean;
  timelineWrite: boolean;
  timelineArtifactWrite: boolean;
  readAfterWrite: boolean;
  incrementalChanges: boolean;
  liveStateRead: boolean;
  playheadWrite: boolean;
  playbackControl: boolean;
  assetDiscovery: boolean;
}

interface AnalyzerCapabilities {
  speechTranscribe: boolean;
  speechVad: boolean;
  audioLoudness: boolean;
  visualTrack: boolean;
}

interface RuntimeCapabilities {
  editor: EditorCapabilities;
  analyzers: AnalyzerCapabilities;
}

Capabilities may depend on the selected backend.

⸻

15. Final Cut Adapter

               FinalCutSessionAdapter
                     │
            BackendSelector
         ┌───────────┼────────────┐
         ▼           ▼            ▼
     FCPXML       Swift/macOS   CommandPost
    document       live state    future

The adapter may combine backends.

Example:

FCPXML document
  → ordered snapshot and artifact mutation
Swift bridge
  → current live application state
CommandPost
  → future mutation provider

The agent runtime should not know which backend fulfilled a request.

⸻

16. Final Cut Backend Selection

interface BackendCapabilityProvider {
  priority: number;
  supports(
    capability: EditorCapability
  ): Promise<boolean>;
  execute<T>(
    request: BackendRequest<T>
  ): Promise<T>;
}

The adapter can therefore select the safest available implementation.

Preference order should generally be:

official/stable API
→ stable interchange format
→ supported automation
→ experimental/private integration

⸻

17. Native Asset Registry

The runtime must model editor-native assets.

interface EditorAsset {
  id: string;
  kind:
    | "transition"
    | "effect"
    | "title"
    | "generator"
    | "audio-effect"
    | "template";
  name: string;
  vendor: string;
  metadata: Record<string, unknown>;
  compatibility?: AssetCompatibility;
}

Agents should be able to query:

find available subtle transitions

without receiving every asset in the editor.

⸻

18. Asset Context Queries

interface AssetRegistry {
  search(query: AssetSearchQuery): Promise<EditorAsset[]>;
  get(assetId: string): Promise<EditorAsset>;
  getCompatibleAssets(
    target: TimelineTarget,
    kind: EditorAsset["kind"]
  ): Promise<EditorAsset[]>;
}

This prevents fabricated effects or transitions.

⸻

19. Media Context Model

interface MediaContext {
  mediaId: string;
  source: MediaReference;
  transcript?: Transcript;
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
  visual?: VisualAnalysis;
  analysisRevision?: string;
}

The runtime stores structured analysis, not model-specific hidden state.

⸻

20. Analysis Ports

Speech

interface SpeechAnalyzer {
  analyze(
    input: MediaInput,
    range?: TimeRange
  ): Promise<SpeechAnalysis>;
}

Audio

interface AudioAnalyzer {
  analyze(
    input: MediaInput,
    range?: TimeRange
  ): Promise<AudioAnalysis>;
}

Visual

interface VisualAnalyzer {
  analyze(
    input: MediaInput,
    range?: TimeRange
  ): Promise<VisualAnalysis>;
}

⸻

21. Analyzer Orchestration

Agents should usually call semantic analysis functions.

Example:

analyzeSpeech

may internally perform:

ASR
+
VAD
+
speaker diarization
+
filler classification

Likewise:

analyzeVisuals

may perform:

shot detection
+
keyframe extraction
+
subject detection
+
tracking

The runtime chooses implementations.

⸻

22. Analysis Cache

Analysis should be cached using:

media fingerprint
source range
analyzer implementation
model version
configuration

Example:

interface AnalysisCacheKey {
  mediaHash: string;
  range: TimeRange;
  analyzer: string;
  version: string;
  configHash: string;
}

⸻

23. Semantic Edit Model

type EditOperation =
  | TrimOperation
  | RippleDeleteOperation
  | InsertOperation
  | MoveOperation
  | GainOperation
  | MarkerOperation
  | CaptionOperation
  | TransitionOperation
  | EffectOperation;

Example:

interface RippleDeleteOperation {
  type: "ripple-delete";
  timelineId: string;
  range: TimeRange;
  reason?: string;
}

⸻

24. Transaction Manager

All meaningful write operations occur through transactions.

interface EditTransaction {
  id: string;
  intent: EditIntent;
  baseRevision: ContextRevision;
  before: ProjectSnapshot;
  planned: EditOperation[];
  applied: AppliedOperation[];
  after?: ProjectSnapshot;
  diff?: TimelineDiff;
  verification?: VerificationReport;
  status: TransactionStatus;
}

⸻

25. Optimistic State Protection

Before applying edits, the runtime must verify that the editor state has not changed unexpectedly.

Example:

Agent planned edit at revision 314.
Current editor revision = 317.
→ reject operation as STALE_CONTEXT
→ refresh relevant context
→ re-plan

This is analogous to optimistic concurrency control.

⸻

26. Transaction Lifecycle

BEGIN
  ↓
READ BASE REVISION
  ↓
PLAN
  ↓
VALIDATE
  ↓
CHECK CURRENT REVISION
  ↓
APPLY
  ↓
RE-OBSERVE
  ↓
DIFF
  ↓
VERIFY
  ↓
PASS ───────→ ACCEPT
  │
  └─ FAIL → RETRY / ROLLBACK

⸻

27. Timeline Diff Engine

The diff engine compares canonical models.

interface TimelineDiff {
  added: TimelineChange[];
  removed: TimelineChange[];
  modified: TimelineChange[];
  durationDelta: RationalTime;
  affectedRanges: TimeRange[];
}

The diff should be deterministic and independent of the LLM.

⸻

28. Verification Engine

interface VerificationEngine {
  verify(
    transaction: EditTransaction,
    policy: VerificationPolicy
  ): Promise<VerificationReport>;
}

A verification policy may come from:

operation defaults
+
skill
+
user constraints

⸻

29. Verification Tiers

Tier 1 — Structural

Fast and deterministic.

timeline validity
expected operation present
media integrity
duration invariants

Tier 2 — Media Signal

speech boundaries
silence duration
LUFS
true peak
clipping

Tier 3 — Local Perceptual

Only affected regions.

preview render
jump cuts
caption layout
visual continuity

Tier 4 — Editorial

Model- or Skill-based.

pacing
tone
style
emotional intent

⸻

30. Affected-Range Verification

The runtime must avoid full-video analysis after every operation.

Example:

Edit:
01:42.300–01:43.100
Verification window:
01:39.000–01:46.000

Window sizes may be selected based on operation type.

⸻

31. Safe Cut Resolver

The agent determines semantic intent.

The runtime determines the physically safe edit boundary.

target filler word
       ↓
word timestamps
       ↓
VAD
       ↓
silence/breath boundary
       ↓
frame alignment
       ↓
safe deletion range

This keeps low-level signal decisions outside LLM reasoning.

⸻

32. Filler Removal Reference Workflow

1. ContextEngine.getRange()
2. SpeechAnalyzer.analyze()
3. FillerDetector.detect()
4. Agent selects semantic candidates.
5. SafeCutResolver.resolve()
6. TransactionManager.begin()
7. EditorPort.applyOperations()
8. ContextEngine.refreshAffectedRanges()
9. DiffEngine.compare()
10. SpeechAnalyzer re-checks affected range.
11. VerificationEngine verifies continuity.
12. Transaction accepted or rolled back.

⸻

33. Dialogue Normalization Reference Workflow

1. Detect dialogue.
2. Group by speaker or clip.
3. Measure loudness.
4. Compute desired gain.
5. Apply gain operation.
6. Re-read affected items.
7. Re-measure.
8. Validate LUFS tolerance and peaks.

⸻

34. Skills

Skills should not contain editor-specific commands.

They may define:

workflow guidance
quality rules
confidence thresholds
analysis requirements
verification policy

Example:

name: podcast-cleanup
version: 1
requires:
  editor:
    timelineSnapshotRead: true
    timelineWrite: true
  analyzers:
    speechTranscribe: true
    speechVad: true
rules:
  fillerConfidence: 0.92
  preservePauseBelowMs: 700
  preserveLaughter: true
verification:
  transcriptContinuity: required
  clippedSpeech: forbidden

⸻

35. Skill Capability Resolution

Before executing a Skill:

Skill requirements
       ↓
Runtime capability registry
       ↓
Editor adapter capabilities
       ↓
Analyzer capabilities

If requirements are missing, the runtime reports the missing capability before editing.

⸻

36. MCP Layer

MCP is an adapter around the runtime.

const runtime = new AgentVideoRuntime(dependencies);
const server = createMcpServer(runtime);

No core package should import MCP SDK packages.

⸻

37. Initial MCP Surface

Recommended conceptual API:

project.inspect
timeline.inspect
timeline.changes
timeline.edit
media.inspect
media.search
speech.analyze
audio.analyze
visual.analyze
editor.assets
edit.diff
edit.verify
edit.undo

MCP resources may be preferable to tools for large read-only context.

⸻

38. Context Budgeting

The runtime must assume project state can exceed model context limits.

Context retrieval should support:

timeline summary
range query
clip query
transcript query
change query
asset query

Avoid:

send entire project XML to model

as the default strategy.

⸻

39. Testing Strategy

The project should itself use strong TDD.

Unit Tests

time conversion
diff engine
safe-cut resolver
operation validation
capability resolution

Golden Fixtures

simple storyline
connected clips
compound clips
multicam
captions
transitions
effects
different frame rates

Adapter Contract Tests

Every editor adapter must pass common tests.

read project
stable identity
apply supported operation
read after write
report capabilities
reject unsupported operation

Integration Tests

Where possible:

open real editor
load test project
read
edit
read again
verify

⸻

40. Compatibility Tests

Every adapter release should be tested against explicitly supported editor versions.

Example:

Final Cut 12.0     supported
Final Cut 12.1     supported
Final Cut 12.2     experimental

Version compatibility must be machine-readable.

⸻

41. Failure Model

Core errors should include:

EDITOR_NOT_CONNECTED
EDITOR_VERSION_UNSUPPORTED
CAPABILITY_UNAVAILABLE
STALE_CONTEXT
MEDIA_NOT_FOUND
ANALYSIS_FAILED
WRITE_FAILED
ROUND_TRIP_MISMATCH
VERIFICATION_FAILED
ROLLBACK_FAILED

Silent best-effort writes should be avoided for destructive operations.

⸻

42. Performance Requirements

The runtime should minimize work using:

incremental project updates
analysis caching
affected-range analysis
proxy media
keyframe extraction
lazy context loading

Large media files should not be copied or repeatedly decoded unnecessarily.

⸻

43. Security and Privacy

Default behavior:

media stays local
analysis stays local where configured
MCP server binds locally
filesystem access is scoped
external upload requires explicit provider configuration

The runtime should make external analysis providers visible and auditable.

⸻

44. Observability

Every transaction should emit structured logs.

{
  "transactionId": "txn_482",
  "editor": "final-cut",
  "baseRevision": "314",
  "operationCount": 3,
  "verification": "pass",
  "latencyMs": 1432
}

Metrics should include:

context sync latency
analyzer latency
write latency
verification latency
cache hit rate
stale-context retries
verification failures
rollback rate
adapter errors

⸻

45. Initial Engineering Sequence

Spike A — Read

Prove:

Final Cut
→ adapter
→ canonical timeline

with real projects.

Spike B — Write

Prove:

canonical edit operation
→ Final Cut

Spike C — Observe Again

Prove:

write
→ refresh
→ canonical diff

This is the most important architectural proof.

Spike D — Speech Loop

Implement:

transcription
VAD
filler detection

Spike E — Verification

Implement:

safe cut
edit
re-analysis
pass/fail
rollback

Spike F — MCP

Expose the working runtime to:

Codex
Claude Code

Spike G — Native Assets

Read available Final Cut transitions/effects/titles and expose them through the Asset Registry.

⸻

46. First End-to-End Acceptance Test

Test media contains:

"So, um, what I wanted to explain is..."

Command:

Remove obvious filler words from the selected range.

Expected sequence:

1. Agent obtains current selection.
2. Runtime obtains transcript and VAD data.
3. "um" is identified.
4. Safe boundaries are computed.
5. Transaction records base revision.
6. Ripple delete is applied.
7. Final Cut state is refreshed.
8. Runtime produces timeline diff.
9. Affected audio is re-analyzed.
10. "So" and "what" remain intact.
11. Verification passes.
12. Transaction becomes VERIFIED.

The agent must not need knowledge of:

FCPXML
Apple Events
Swift bridge internals
speech model implementation
Final Cut version-specific calls

⸻

47. Second Acceptance Test — Native Asset Use

Command:

Add a subtle transition between these two clips using something already available in Final Cut.

Expected sequence:

1. Runtime identifies selected edit point.
2. Asset Registry queries compatible transitions.
3. Agent chooses from real installed assets.
4. Semantic transition operation is created.
5. Final Cut adapter applies it.
6. Runtime re-observes timeline.
7. Diff confirms transition insertion.
8. Verification validates timeline integrity.

No nonexistent transition may be hallucinated.

⸻

48. Architectural Definition of Success

The architecture is successful when a coding agent can treat a professional video editor similarly to a software repository:

inspect
understand
change
diff
test
retry

while remaining isolated from editor-specific implementation details.
