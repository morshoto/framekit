# v0.0.2 Skill conformance gate

The v0.0.2 gate validates the neutral `fixture.add-marker` Skill independently
of product-specific workflows:

1. register, list, and inspect the version-pinned manifest;
2. resolve its requirements against the active capabilities;
3. preview without changing the snapshot;
4. execute with a runtime-issued token;
5. verify the transaction and report rollback evidence;
6. run the same definition against the in-memory and FCPXML adapters; and
7. report the Skill unavailable for a metadata-only live backend.

Run the deterministic gate with:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

Native validation is not required for this fixture because it does not change
the Swift bridge. The FCPXML result is artifact evidence, not proof that an
open Final Cut project was changed. Live metadata-only output must remain
unavailable and must not inherit fixture capabilities.
