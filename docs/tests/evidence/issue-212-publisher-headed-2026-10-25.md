# Issue 212 headed publisher evidence

Date: 2026-10-25

## Run

`pnpm run test:final-cut-publisher-headed` passed against a fresh disposable Final Cut library after the imported project was opened from its Event Browser entry. Final Cut accepted the FCPXML 1.11 fixture and the publisher completed active-target and canonical timeline readback.

The fixture uses a declared video format and a sequence `format` reference. FCPXML 1.11 does not declare `name` or `uid` attributes on `sequence`, so Final Cut derives the sequence display name from the project name.

## Created target

- Library: `Framekit 212 Retry23.fcpbundle`
- Library ID: `B7DB10B4-A626-45C4-A290-6EF9C1CA6CEF`
- Event ID: `6C0A1121-FB94-4688-8925-F8352AB562BD`
- Project: `Framekit 212 Disposable QA`
- Project ID: `BC463DDE-B9A4-4B2C-A724-D9FE3C82F39F`
- Sequence: `Framekit 212 Disposable QA`
- Sequence ID: `Ay5SKdzQSEa/oi8WF3DJ+w`

## Active-project readback

- Before: project `8687F119-73C0-4DE0-AD2C-594E06B7B4BD`, sequence `hLzlPyxJS0q2NnuLBUmoxQ`
- After: project `BC463DDE-B9A4-4B2C-A724-D9FE3C82F39F`, sequence `Ay5SKdzQSEa/oi8WF3DJ+w`
- The active project changed to the created project; live project and sequence IDs matched the created-target catalog IDs.

## Readback and integrity

- Semantic readback: verified; expected and observed digest `d6aba9b922bece8adfb9204c85283fc8f32d3ca8c8c0a620c85bb483030bcc21` matched.
- Checked project and sequence names, duration and frame rate, clip order and source ranges, title content and timing, connected audio role/gain/timing, other timeline elements, markers and captions, and source-media bindings.
- Source-media integrity: unchanged. The disposable fixture contains no external source-media assets, so the digest list was empty.

No absolute temporary paths, transaction IDs, or raw UI snapshots are included.
