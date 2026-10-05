# Framekit Project Persistence

Issue: [#465](https://github.com/morshoto/framekit/issues/465)

Status: v0.1.15 implementation contract

`FramekitProjectStore` persists the canonical `TimelineIr` inside a small
versioned project envelope. The envelope keeps project metadata separate from
the Timeline IR without introducing another timeline model:

```json
{
  "schemaVersion": 1,
  "metadata": {
    "createdAt": "...",
    "updatedAt": "..."
  },
  "timeline": "provider-neutral TimelineIr"
}
```

The project ID, sequence ID, asset/resource IDs, occurrence IDs, exact rational
times, provider bindings, and project revision all come from the canonical
Timeline IR. A provider-specific identifier is retained only in an explicit
binding and never replaces a logical identity.

## Write protocol

1. Validate the complete canonical document, including the Timeline IR schema.
2. When an expected revision is supplied, load the existing document and reject
   a mismatch before creating a replacement.
3. Create a uniquely named sibling temporary file with exclusive creation.
4. Write the deterministic canonical encoding to the temporary file.
5. Rename the temporary file over the project path as the commit point.
6. Remove only the temporary file after success or failure.

The existing project file is not opened for truncation. A failed or interrupted
write therefore leaves the previous valid document in place; a leftover
temporary file is not treated as project state.

## Read and schema safety

Loading parses JSON, checks the supported project schema version, validates the
metadata, and validates the complete Timeline IR before returning a clone.
Malformed JSON, missing required fields, duplicate logical IDs, invalid timing,
and unknown resource references return `PROJECT_CORRUPT` diagnostics. A future
schema version returns `PROJECT_SCHEMA_UNSUPPORTED` and is not guessed or
downgraded.

`FramekitProjectMigration` is the extension point for a later migration
milestone. Version 1 has no migration behavior: unsupported versions fail
closed until an explicit, tested migration is registered. Project revisions are
state/concurrency tokens and are not history commits, branches, or revert
records.

The store is editor-independent and does not launch, inspect, or synchronize
with Final Cut Pro or another NLE.
