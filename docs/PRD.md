The biggest change is that the product is no longer just “MCP + editing operations.” It is becoming a local agent runtime that continuously translates an NLE session into agent-usable context, including the editor’s own assets/effects, then gives the agent verifiable editing primitives. That distinction is important enough to revise the architecture around it.

Product Requirements Document

Agentic Video Editing Runtime

Version: 0.2
Status: Working Draft
Date: August 2026
Initial Editor: Final Cut Pro
Future Editors: Adobe Premiere Pro, DaVinci Resolve
Primary Agent Clients: Codex, Claude Code, MCP-compatible agents
Initial Runtime Direction: Local-first
Initial Implementation Direction: TypeScript + Swift

⸻

1. Executive Summary

Agentic Video Editing Runtime is an open-source infrastructure layer that makes professional video editors understandable and controllable by AI agents.

The initial implementation targets Final Cut Pro, but the system is editor-agnostic by design.

The project allows an agent such as Codex or Claude Code to:

1. inspect the current editing project;
2. understand its timeline, media, audio, transcript, effects, transitions, and editor-native assets;
3. analyze media using specialized perception tools;
4. plan semantic editing operations;
5. execute those operations through the active video editor;
6. observe what changed;
7. verify the result using deterministic and model-based checks;
8. retry or roll back unsuccessful edits.

The product goal is not:

“Expose Final Cut functions through MCP.”

The goal is:

Create the runtime required for coding-style agents to work inside professional video editing environments.

The intended interaction model is:

User
  ↓
Codex / Claude Code
  ↓
MCP
  ↓
Agentic Video Runtime
  ↓
Context + Analysis + Editing + Verification
  ↓
Final Cut Pro

⸻

2. Product Vision

Turn professional video editors into agent-native applications.

Coding agents became powerful because they can continuously inspect and modify a software environment.

They have:

Repository
Filesystem
Git diff
Terminal
Tests
Logs
Compiler

A video-editing agent needs equivalent infrastructure:

Timeline
Media
Transcript
Editor assets
Edit history
Video diff
Audio/visual analyzers
Verification
Editor controls

The runtime should provide this environment.

⸻

3. Core Product Thesis

The primary technical bottleneck in agentic video editing is not model intelligence alone.

The larger bottlenecks are:

* obtaining reliable editor state;
* normalizing editor-specific data;
* understanding source media;
* exposing useful editing capabilities;
* observing changes after writes;
* verifying that edits are correct;
* maintaining compatibility across editor versions.

The product should therefore solve the environment problem around the model rather than attempting to build a proprietary editing model.

As frontier models improve, the runtime should improve automatically because agents gain better reasoning while continuing to use the same editor environment and tools.

⸻

4. Product Principles

4.1 Final Cut first, editor-agnostic by design

Final Cut Pro is the first adapter.

Final Cut-specific concepts must not define the runtime API.

Future implementations should support:

Final Cut Pro
Adobe Premiere Pro
DaVinci Resolve

through common semantic contracts.

⸻

4.2 Local-first architecture

Professional video projects often contain:

* unreleased footage;
* client materials;
* licensed music;
* confidential interviews;
* large media files.

The primary runtime should therefore execute locally.

The preferred architecture is:

Codex / Claude Code
       │
       │ MCP
       ▼
Local MCP Server
       │
       ▼
Local Video Runtime
       │
       ▼
Final Cut Pro

A remotely deployed MCP server must not be required for the core experience.

Cloud-based perception services may be supported later as optional providers.

⸻

5. The Three Core Problems

The project is organized around three major technical problems.

Problem 1 — Editor Context and Control

Determine how to reliably obtain and modify:

* project information;
* timeline structure;
* clips;
* connected clips;
* audio;
* roles/tracks;
* captions;
* markers;
* effects;
* transitions;
* current selection;
* playhead state;
* media references;
* editor-native assets.

The system must normalize this into a canonical model.

⸻

Problem 2 — Agent Loop and Verification

Provide the equivalent of a coding-agent TDD cycle:

Observe
→ Plan
→ Edit
→ Re-observe
→ Verify
→ Retry / Accept / Rollback

Perception and verification may use tools such as:

* speech recognition;
* VAD;
* speaker diarization;
* audio loudness analysis;
* scene detection;
* subject tracking;
* visual-language models.

⸻

Problem 3 — Agent Connectivity

Expose runtime capabilities through MCP so that agents such as:

* Codex;
* Claude Code;
* other MCP clients

can operate the editor through natural-language interaction.

MCP is an interface to the runtime, not the runtime itself.

⸻

6. Context Is a First-Class Product

The product must expose more than the raw timeline.

The agent should receive an Agent Editing Context.

Example:

Project: Interview Episode 12
Timeline: Main Cut
Duration: 42:18
Current selection:
  clip_123
  12:14.2–12:26.8
Speech:
  Speaker A
  "The reason we started..."
  confidence: 0.98
Visual:
  Speaker A visible
  centered
  medium shot
Audio:
  dialogue: -19.4 LUFS
Connected items:
  lower-third title
  background music
Recent changes:
  clip_122 trimmed -1.2s
  marker added at 12:09

The agent should not need to reconstruct these relationships from raw editor data.

⸻

7. Incremental Context Synchronization

Repeatedly reading and serializing an entire large project is expensive.

The runtime should therefore support:

Initial snapshot
+
incremental changes

The desired interaction is:

Agent reads project once
        ↓
Editor changes
        ↓
Runtime produces structured diff
        ↓
Agent reads only relevant changes

Example:

Revision 184 → 185
Changed:
- clip_234 trimmed by 18 frames
- marker_91 created
- playhead moved to 14:22.03
Unchanged:
- 428 other timeline items

This acts as a video-editing equivalent of:

git diff

and reduces context size and latency.

⸻

8. Native Editor Assets

Agents must be able to understand and use capabilities already available inside the editor.

For Final Cut this may include:

* transitions;
* titles;
* generators;
* effects;
* installed templates;
* audio effects;
* roles;
* editor-provided assets.

The agent should not invent a generic transition if the user’s editor already contains an appropriate native transition.

Example request:

Add a subtle transition between these two scenes.

The runtime should allow the agent to:

list available transitions
→ inspect metadata
→ select compatible transition
→ apply transition
→ verify result

Native editor resources are therefore part of context, not merely write operations.

⸻

9. Media Understanding

Timeline structure is insufficient for meaningful editing.

The system must provide a perception layer for source media.

The runtime should support derived metadata such as:

Transcript
Word timestamps
Speech ranges
Silence ranges
Speakers
Scenes
Subjects
Object tracks
Motion
Loudness
Audio peaks
Media embeddings
Thumbnails
Keyframes

The project does not need to own long-term agent memory.

Its responsibility is to make media understandable in a structured form that external agents can consume and remember using their own context or memory systems.

⸻

10. Analysis Architecture

Analysis should be modular.

Examples:

Speech

ASR / Whisper-family
VAD
speaker diarization
filler detection

Audio

LUFS
true peak
silence
clipping
noise floor

Video

scene detection
subject detection
segmentation
tracking
motion analysis
frame extraction

The agent should normally consume combined semantic results rather than directly orchestrating every low-level model.

⸻

11. Semantic Editing Operations

The agent should reason in editor-independent operations.

Examples:

InspectRange
TrimClip
RippleDelete
InsertMedia
MoveClip
ReplaceClip
AdjustGain
AddMarker
AddCaption
ApplyTransition
ApplyEffect

The agent should not normally reason about:

FCPXML nodes
Premiere TrackItem methods
Resolve TimelineItem calls

⸻

12. Agent Loop

Every meaningful edit should support the following lifecycle:

OBSERVE
   ↓
ANALYZE
   ↓
PLAN
   ↓
EDIT
   ↓
RE-OBSERVE
   ↓
DIFF
   ↓
VERIFY
   ↓
PASS / RETRY / ROLLBACK

An agent should be able to complete this loop without asking the user to manually export and re-import project state whenever technically possible.

⸻

13. Video TDD

The runtime should introduce testing concepts for editing.

Not every editing decision has a deterministic answer, so verification is hierarchical.

Tier 1 — Structural

Examples:

project remains valid
media references resolve
clip durations are non-negative
expected timeline change occurred

Tier 2 — Signal

Examples:

speech was not clipped
target LUFS reached
audio does not peak above threshold
silence duration meets target

Tier 3 — Perceptual

Examples:

jump cut is visually acceptable
caption does not overflow
subject remains framed

Tier 4 — Editorial

Examples:

pacing improved
emotional pause preserved
B-roll supports dialogue
style matches selected skill

⸻

14. Video Diff

Every edit transaction should produce an inspectable change set.

Example:

Edit #482
Intent:
Remove filler word
Before:
12:42.210–12:43.081
"and, um, we decided..."
After:
12:42.210–12:42.641
"and we decided..."
Removed:
440 ms
Affected:
- primary clip
- 1 connected caption
Verification:
✓ previous word preserved
✓ next word preserved
✓ no structural errors

The diff system is a core product feature.

⸻

15. Editing Transactions

Destructive editing should occur through transactions.

A transaction contains:

intent
before state
proposed operations
applied operations
after state
diff
verification results
status

Possible statuses:

PLANNED
APPLIED
VERIFIED
FAILED
ROLLED_BACK
ACCEPTED

⸻

16. Initial Closed-Loop Tasks

The first tasks should be deliberately simple and measurable.

16.1 Filler-word removal

Pipeline:

transcribe
→ detect filler
→ resolve safe speech boundaries
→ ripple delete
→ re-read
→ re-transcribe affected region
→ verify adjacent speech

⸻

16.2 Dialogue normalization

Pipeline:

detect dialogue
→ measure loudness
→ calculate gain
→ apply adjustment
→ measure again
→ verify target and peaks

These use cases demonstrate the full agent loop without requiring subjective end-to-end editing.

⸻

17. Skills

Runtime tools represent capabilities.

Skills represent editing knowledge.

Example:

Runtime:
detect silence
remove range
measure LUFS
Skill:
Podcast Cleanup

A skill may define:

workflow
analysis requirements
editing policies
confidence thresholds
verification rules
editorial preferences

Example:

name: podcast-cleanup
rules:
  filler_confidence: 0.92
  preserve_pause_below_ms: 700
  target_pause_ms: 500
  preserve_laughter: true
verification:
  transcript_continuity: required
  clipped_speech: forbidden

Professional editors should eventually be able to publish reusable Skills.

⸻

18. MCP Experience

The intended experience is:

$ agent-video connect finalcut
✓ Final Cut detected
✓ Project: Interview Episode 12
✓ Timeline: Main Edit
✓ Context ready
✓ MCP server ready

Then inside an MCP-compatible agent:

> Inspect the current edit.
> Find obvious filler words.
> Remove the high-confidence ones.
> What changed?
> Undo the third edit.

The agent should not need to understand the underlying editor integration.

⸻

19. MCP Tool Surface

The MCP surface should remain compact.

Initial conceptual tools:

project.inspect
timeline.inspect
timeline.changes
media.inspect
media.search
speech.analyze
audio.analyze
visual.analyze
editor.assets
timeline.edit
edit.diff
edit.verify
edit.undo

Low-level analyzer and editor APIs should remain internal wherever possible.

⸻

20. Editor Adapter Architecture

The common runtime must support multiple editors.

              Runtime
                 │
             EditorPort
        ┌────────┼────────┐
        ▼        ▼        ▼
   Final Cut  Premiere  Resolve

Each adapter may itself support multiple integration methods.

Example:

FinalCutAdapter
     │
     ├── FCPXML backend
     ├── macOS automation backend
     ├── CommandPost backend
     └── future integration backend

The adapter chooses the strongest available capability while exposing one common interface upward.

⸻

21. Compatibility Strategy

Editor versions will change.

The runtime must treat compatibility as an explicit engineering concern.

Each adapter should expose:

editor version
backend version
supported capabilities
known limitations

Unsupported operations should fail explicitly rather than silently degrade.

A public compatibility matrix should be maintained.

⸻

22. Final Cut-Specific MVP

The initial Final Cut version should prove:

Read

* project metadata;
* timeline;
* clips;
* connected clips;
* media references;
* markers;
* captions where available;
* installed or available editor assets where feasible.

Analyze

* transcript;
* speech boundaries;
* silence;
* loudness.

Write

* trim;
* ripple delete;
* gain adjustment;
* marker creation.

Verify

* read-after-write;
* timeline diff;
* transcript continuity;
* audio measurements.

⸻

23. Technical Success Criteria

The initial architecture is proven when an MCP agent can perform:

User:
"Remove obvious filler words from this section."

through:

Codex / Claude Code
        ↓
MCP
        ↓
Runtime
        ↓
Current timeline context
        ↓
Speech analysis
        ↓
Semantic edit plan
        ↓
Final Cut adapter
        ↓
Final Cut
        ↓
Incremental re-observation
        ↓
Video diff
        ↓
Verification

without the agent knowing Final Cut-specific implementation details.

⸻

24. MVP Success Metrics

Technical targets:

* deterministic timeline parsing for the supported fixture corpus;
* no silent timeline corruption;
* frame/time precision preserved during round trips;
* 95% successful verification on controlled filler-removal fixtures;
* edit rollback support;
* incremental context updates after edits;
* successful MCP invocation from at least Codex and Claude Code;
* local setup without requiring a hosted service.

⸻

25. Non-Goals

The first release will not attempt to:

* autonomously create complete professional films;
* replace professional editorial judgment;
* support every Final Cut feature;
* support every NLE simultaneously;
* perform advanced color grading;
* provide a proprietary foundation model;
* become a cloud video editor;
* maintain the agent’s long-term memory.

⸻

26. Roadmap

Phase 0 — Technical Spikes

Prove:

read
write
read-after-write
diff
MCP connection

⸻

Phase 1 — Final Cut Runtime

Implement:

Final Cut adapter
timeline context
speech/audio analysis
transactions
verification
MCP

⸻

Phase 2 — Context Engine

Add:

incremental synchronization
visual analysis
media understanding
native asset discovery

⸻

Phase 3 — Skills

Ship:

filler removal
podcast cleanup
dialogue normalization
interview cleanup

and public Skill authoring APIs.

⸻

Phase 4 — Premiere

Implement the same adapter contract against Premiere.

⸻

Phase 5 — DaVinci Resolve

Implement Resolve adapter.

⸻

Phase 6 — Advanced Editing Agents

Explore:

B-roll selection
speaker-aware reframing
rough cuts
pacing optimization
multi-camera workflows
editorial review agents

⸻

27. Long-Term Positioning

This project should not be positioned as:

“An MCP server for Final Cut Pro.”

It should be positioned as:

The open runtime for agentic video editing.

Final Cut Pro is simply the first editor where that runtime is proven.

The runtime—not the model and not MCP—is the central product.

I’d treat these as v0.2, not a final specification. The two biggest unresolved technical decisions now are how Final Cut → runtime incremental synchronization actually works, and which operations belong in the universal semantic editing model versus editor-specific capability extensions. Those are the areas worth proving with code before expanding the documents further.