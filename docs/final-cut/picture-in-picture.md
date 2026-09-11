# Native picture-in-picture

Framekit supports picture-in-picture as a connected video placement with an
explicit provider contract. The operation is separate from masking, tracking,
and person cutout; those capabilities remain unavailable unless a provider
advertises and verifies them independently.

## Contract

The deterministic timeline operation is
`timeline.picture-in-picture.add`. It requires a stable project/sequence
target, a connected non-primary lane, a video media ID, an existing primary
occurrence, frame-aligned timing, position, and scale. Optional crop and solid
frame properties are validated before mutation.

The FCPXML document backend writes the connected `asset-clip`, transform, and
schema-compatible crop adjustment (`adjust-crop` / `crop-rect`) in the
canonical snapshot. Solid frame styling is not an FCPXML document capability;
artifact requests that include a frame fail closed and must use the native
Final Cut provider. Its preview is non-mutating; execute returns a verified
transaction, diff, and Undo restoration digest.

The headed Final Cut backend uses the native tools:

1. `editor.native.media.search` and `editor.native.media.select` identify and
   bind the secondary Browser video.
2. `editor.native.timeline.locate` identifies the primary occurrence.
3. `editor.native.picture-in-picture.preview` binds both handles and the live
   sequence revision without editing.
4. `editor.native.picture-in-picture.execute` connects the video, applies the
   transform/crop/frame through the Video Inspector, and reads those properties
   back before returning success.
5. `editor.native.undo` restores the operation through Final Cut's native Undo.

If the Browser identity, occurrence, live revision, Inspector property, or
Undo command cannot be verified, the operation fails closed. It never silently
uses masking, tracking, a generated asset, or an external renderer.

## Evidence tiers

These results must remain distinct:

- Fixture evidence proves the runtime contract and rollback semantics.
- FCPXML evidence proves canonical connected placement and persisted properties.
- Headed-native evidence proves Final Cut UI placement, Inspector readback,
  revision advancement, and native Undo.

The headed runner requires a disposable or explicitly approved project and
these variables:

```sh
FRAMEKIT_FINAL_CUT_E2E_PROJECT="Framekit Native PIP E2E" \
FRAMEKIT_FINAL_CUT_E2E_ANCHOR_QUERY="Primary" \
FRAMEKIT_FINAL_CUT_E2E_PIP_QUERY="Guest" \
FRAMEKIT_FINAL_CUT_E2E_PIP_START="2/1" \
FRAMEKIT_FINAL_CUT_E2E_PIP_DURATION="4/1" \
pnpm run test:final-cut-pip-headed
```

The output is a sanitized `headed-native-picture-in-picture` evidence record.
It does not claim canonical snapshot or person-cutout support.
