# Issue #520 Codex video workflow acceptance

**Result: headless production acceptance passed; native Final Cut handoff remains blocked.**

## Candidate and fixture

- Run date: 2026-10-12.
- PR #526 candidate head: `1b22d097ccb4440abe951a97e0786abe78ce7efe`.
- Codex CLI: `0.162.1`; installed Framekit plugin: `0.1.17`.
- Production MCP server: `framekit-full-coverage`, running the candidate worktree.
- Inputs: [the consent-safe synthetic speech fixture specification](../../../tests/fixtures/codex-video-speech/fixture-spec.json). Generate its distinct-color cards, local macOS `say` narration, and FFmpeg music with `node scripts/generate-codex-video-speech-fixtures.mjs /tmp/framekit-codex-speech-fixture`. The generator writes a manifest containing the resulting file hashes; it does not create or assert VAD evidence. There are no human recordings or personal media.

The production `command.speech` analyzer (`local-whisper-webrtcvad@1`, MLX Whisper tiny plus WebRTC VAD) confirmed speech across every approved source range:

| Source | SHA-256 | VAD speech interval | Approved source range |
| --- | --- | ---: | ---: |
| B | `6c197c9874ee44ed8a6cca1cefb1ec959e2f2f7211ec9d274503ea79c08b1d0d` | 4.80–13.77s | 5–13s |
| A | `e4702e13da203ff79e2de9ab9eb82145e531fbed334b3bfc7de2b8b6b68ee365` | 9.84–23.46s | 10–22s |
| C | `1f955e1e5ef2201013bc3b7e1691c7b9a4c67e87670bcbc9bd707ae1971c1fef` | 1.83–12.75s | 2–12s |

The model returned 29, 44, and 37 words for B, A, and C. Audio loudness/noise, visual, and metadata analyzers were not configured and are not claimed as evidence.

## Approved preview and execution

The user approved preview digest `88838e43e25076d8c2a130997705af4354ea82629094ce0c0d72c047bb2b3661`. The unchanged plan placed B source 5–13s at timeline 0–8s, A source 10–22s at 8–20s, and C source 2–12s at 20–30s; added the editable title `FrameKit MVP Test` at 0–6s; and added generated music at 0–30s at −12 dB with source audio preserved and mixed.

Codex called `headless.rough-cut.execute` with that digest and `approved: true` through the production MCP. Execution `rough-cut-60ad0f19-327c-4e23-aabd-dacd8af382f1` committed Framekit headless revision `ir:de6153615fae9754ba3d9d0701b5e8ee5491f8ba2574f213de1bb6efd4fbcb0d` (sequence 5). Render `render-2bdba5de-4df5-4c64-8bb5-c48f53ccfb8c` passed independent verification.

The MP4 was written only to the isolated temporary output directory and verified as a playable 30-second, 1280×720, 24 fps file with AAC audio at 48 kHz mono. Every render check passed: existence, SHA-256, file stability, playability, format, dimensions, frame rate, audio stream, and duration.

- MP4: `highlight.mp4`, SHA-256 `0b0692c4bf07c73c5b94deac7a797af1f4ec6aa37d07526556d05179607e0f54`.
- FCPXML: `highlight.fcpxml`, 4,469 bytes, SHA-256 `4b11a5b5f8349becd8bc07eaa6f16e74a59b2e2cbe812a38286b829ed24b7b5e`, matching the preview digest. The preview reported exact coverage for the artifact, connected elements, editable title, gain, storyline order, project, provenance, resources, roles, sequence, source ranges, and versioned destination; no degraded or unsupported items.

The accepted run is bound to the source hashes above. Re-generating the fixture may produce different file digests across macOS speech and FFmpeg versions; re-run `media.understand` and confirm VAD coverage before planning. A different file path or digest creates new path-bound provenance and requires a new preview approval; this recorded approval must not be reused for changed inputs. The MP4 and FCPXML outputs remain outside the repository.

## Native handoff boundary

No Final Cut import or artifact-publish execute call was made. Read-only headed preflight reported `artifactPublish=false` and `timelinePublishNewProject=false`: the production publisher has no target-binding provider. The FCPXML destination UIDs are proposed identifiers, not native reservations or verified Final Cut identities. The extension fingerprint was also unavailable, so build alignment and native readback remain unproven.

Keep #520 open and this PR in draft until a real target-binding provider and the separately authorized native acceptance/readback are available. This headless pass is not a native Phase B pass or a release-candidate verdict.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- `pnpm run build`: passed.
- `pnpm run test`: 1,290 passed, 1 skipped.
- `pnpm run check:boundaries`: passed.
- Xcode/native checks were not required because this change does not modify native files.
