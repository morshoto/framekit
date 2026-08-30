# Semantic Media Understanding Tests

The deterministic semantic-media suite covers the runtime and MCP contracts
for issue #91:

- exact source identity, digest, and usable-range provenance;
- independent metadata, visual, audio, and speech analyzer capabilities;
- partial results when one configured analyzer cannot process an asset;
- unavailable statuses without invented semantic descriptions;
- semantic filtering by properties and overlapping usable ranges; and
- deterministic, explainable, read-only rough-cut shot plans.

The default MCP process uses explicit fixture annotations and fixture analyzer
descriptors. Those records prove contract behavior only; they are not claims
about analysis of live media. Final Cut analysis uses independently configured
local JSON commands through `FRAMEKIT_*_ANALYZER` variables.

Run the focused suite with:

```sh
pnpm exec tsx --test tests/integration/semantic-media.test.ts
```

Run the full deterministic validation with:

```sh
pnpm run test
```
