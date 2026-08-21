# ADR-0006: Live Browser Editing and FCPXML Project Publishing

- Status: Accepted
- Date: 2026-08-21

## Context

Final Cut's Workflow Extension exposes live project metadata, playhead state,
and change events, but not a complete media/timeline model or canonical write
API. The supported library scripting dictionary is inspection-only. Accessibility
automation can operate visible UI controls, but selection and Browser identity
are transient.

## Decision

Framekit adds two explicit write paths:

1. Native UI automation searches the active Browser, selects a media result,
   locates matching timeline occurrences, and performs Blade-at-playhead only
   through short-lived handles and expiring preview tokens.
2. Canonical FCPXML edits are validated on disk and can be imported as a new
   Final Cut project. The active project is never replaced automatically.

Browser media identity and timeline occurrence identity remain separate. Native
operations fail closed on stale handles, ambiguous matches, missing focus,
missing permissions, unavailable selection, or failed post-command verification.

## Consequences

- `timelineWrite` remains false for the live Workflow Extension backend.
- Live Browser and Blade tools are distinct from canonical `media.search` and
  `timeline.edit`.
- A full publish produces a new project rather than silently changing the
  active project.
- Headed Final Cut validation is required for UI behavior; deterministic tests
  cover scripts, handles, tokens, and failure contracts.
