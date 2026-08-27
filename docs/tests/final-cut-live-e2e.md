# Final Cut Pro Live E2E Test

Status: bundled Workflow Extension metadata path passed locally; canonical live
provider contract covered deterministically and gated by an opt-in headed run.

## Purpose

Prove that Final Cut Pro can host the Framekit Workflow Extension and that the
MCP runtime can read live project/sequence state. When an explicit FCPXML path
is supplied, separately prove canonical artifact reads and edits without
claiming that the open Final Cut timeline was mutated.

## Environment

- macOS 26.5.1
- Final Cut Pro 10.7.1
- Xcode 16.4, build 16F6
- macOS SDK 15.5
- project: `Framekit Phase 1 E2E`

## Build and connect

```sh
npm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
framekit connect finalcut --development --json
```

The command detects or launches Final Cut, installs the development bundle into
the per-user Applications directory, gracefully reloads Final Cut when the
bundle replaces the installed extension, and activates the extension. Verify
the socket exists:

```sh
ls -l ~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock
```

## MCP assertions

Use the live backend through the standard Codex MCP registration:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

The MCP `connection.status` tool should report `ready` before the live state
assertions are run.

The live MCP client should observe:

- identity backend: `workflow-extension-ipc`;
- project: `Framekit Phase 1 E2E`;
- active sequence: `Framekit Phase 1 E2E`;
- a valid playhead rational time;
- a valid sequence time range;
- revisions for active sequence, sequence range, and playhead changes.

For canonical MCP coverage, start the server with:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FCPXML_PATH=/absolute/path/to/exported.fcpxml \
framekit mcp --editor final-cut-live
```

Then verify `project.inspect`, `timeline.inspect`, `context.inspect`,
`timeline.edit`, `edit.diff`, `edit.verify`, and `edit.undo`. Configure local
JSON analyzers and Motion-template roots separately when testing media analysis
and `editor.assets`.

## Safety boundary

The live-only test must not write timeline edits, alter media, or claim full
native timeline enumeration. The FCPXML test may edit only its managed fixture
artifact. Unsupported native operations must remain fail-closed.

## Headless deterministic native-contract E2E

The default Final Cut validation is headless and does not launch, activate, or
focus Final Cut Pro. It uses deterministic native and MCP fixtures to verify
the same fail-closed contracts, including overlay minimization through
`AXMinimize`, timeline focus races, missing windows, Blade, range deletion,
duration trimming, media append/insert, and Undo:

```sh
pnpm run test:final-cut-headless
```

This is the supported validation path for Codex and CI. It does not claim that
the open Final Cut timeline was changed.

## Disposable headed overlay validation

For the required macOS UI proof, use a disposable project and run the explicit
overlay runner. It makes the Framekit window visible through Accessibility,
then invokes the shared native preflight; no user click or Codex Computer Use
session is required:

```sh
FRAMEKIT_FINAL_CUT_E2E_PROJECT="Framekit Native E2E 2" \
pnpm run test:final-cut-overlay-headed
```

The runner verifies that the Framekit window began visible, that the preflight
detected and minimized it with `AXMinimize`, raised and focused Final Cut's
timeline, trimmed one disposable second, observed the new duration through
live state, and restored the original duration through native Undo. The runner
also records the operation-specific Undo command and verifies that the live
revision and duration return to their pre-edit values. It fails
closed if the project name does not match or if the overlay cannot be
minimized.

The overlay Accessibility probe reports stable recovery diagnostics:

- `FINAL_CUT_E2E_ACCESSIBILITY_PERMISSION_REQUIRED`: grant Accessibility
  permission to the headed test host in System Settings > Privacy & Security >
  Accessibility.
- `FINAL_CUT_E2E_FINAL_CUT_PROCESS_MISSING`: open Final Cut Pro and the Framekit
  Workflow Extension.
- `FINAL_CUT_E2E_OVERLAY_WRONG_PROCESS`: open the Framekit extension from
  Window > Extensions > Framekit so its window is hosted by Final Cut Pro.
- `FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING`: open the Framekit extension in Final
  Cut Pro.
- `FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE`: make the Framekit window visible and
  retry.

These diagnostics are intentionally actionable and do not expose private paths
or media. The runner remains fail-closed if Accessibility cannot verify the
overlay before the native preflight.

## Canonical live provider evidence

When a live bridge advertises `canonicalTimelineMode: canonical-write`, open a
disposable project, copy one occurrence ID from `project.inspect`, and run:

```sh
FRAMEKIT_FINAL_CUT_E2E_PROJECT="Framekit Canonical E2E" \
FRAMEKIT_FINAL_CUT_E2E_CLIP_ID="final-cut:occurrence:example" \
pnpm run test:final-cut-canonical-headed \
  > docs/tests/evidence/$(date +%F)-canonical-live.json
```

The runner disables FCPXML composition, verifies the exact project and
occurrence before mutation, renames that occurrence, and performs compensating
undo. It emits a sanitized evidence document using an allowlisted summary
rather than the raw snapshots returned by the MCP tools. The document records
the Framekit version, full Git commit, runtime environment, Final Cut
identity/version, capability payload, required tool results, target IDs,
verified revision/diff summaries, and matching pre-edit/restored digests. It
proves that the open canonical timeline changed through the verified target
diff and advancing revision, then proves restoration through the matching
canonical digest. If the bridge is metadata-only or canonical-read, it fails
before calling `timeline.edit`.

Before attaching the JSON to a release or pull request, review that it contains
no private media paths, raw snapshots, transaction identifiers, credentials,
or diagnostics. The runner and sanitizer both fail closed when the mutation,
undo, required tool sequence, or full commit provenance is incomplete.

## Optional native UI validation

Final Cut Pro does not provide a supported headless Accessibility mode. Native
Blade and range edits require a visible Final Cut timeline, so they are not
part of the headless test command. The native adapter remains fail-closed and
is covered by deterministic executor tests. If a separate macOS UI smoke test
is run manually, use a disposable project and do not treat it as headless or
as a CI requirement. For media insertion, enable native writes and connect the
live backend, search and select one Browser media handle, preview and execute
one append, assert the returned duration and revision changed, then call native
Undo and assert the original duration returns. Repeat with insert at a
non-terminal playhead position. For local media import validation, enable
native writes,
call `editor.native.media.import` with one disposable `.mov` and one disposable
audio file, then pass each returned `mediaHandle` to
`editor.native.media.select`. Confirm that the returned `sourcePath`, `kind`,
and stable handle are correct and that an invalid path fails before the import
dialog opens. Do not use private media or commit test files.
