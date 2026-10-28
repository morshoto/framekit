# Test suites

`pnpm run test` is the required aggregate gate. It runs the documentation tests
and every reviewed TypeScript test file under `tests/`, `packages/`, `apps/`,
and `adapters/`. The manifest at `scripts/test-suite-manifest.json` records the
collected files and suite tags. If a file is added, moved, or removed, the
aggregate blocks until the inventory is reviewed and refreshed with
`pnpm run test:inventory:update`.

Run `pnpm install --frozen-lockfile` first. Test files run with the same
isolated home and writable-state setup as the aggregate gate.

| Command | Coverage | Prerequisites |
| --- | --- | --- |
| `pnpm run test:unit` | Owner-local runtime, adapter, and app tests plus focused shared unit tests. | Node.js 20 or newer. |
| `pnpm run test:contracts` | MCP schemas, protocol, capabilities, and service contracts. | Node.js 20 or newer; FFmpeg is needed for any selected headless contract test. |
| `pnpm run test:fixtures` | Fixture-backed workflows across shared test owners. | Node.js 20 or newer, FFmpeg, ffprobe, and npm. |
| `pnpm run test:integration` | Cross-component integration tests. | Node.js 20 or newer, FFmpeg, ffprobe, and npm. |
| `pnpm run test:headless` | Headless render and rough-cut workflows. | Node.js 20 or newer, FFmpeg, and ffprobe. No Final Cut process is needed. |
| `pnpm run test:native` | Native-adapter contracts backed by deterministic fakes. | Node.js 20 or newer, FFmpeg, and ffprobe. It does not launch Final Cut. |
| `pnpm run test:package` | Built-package and clean-client smoke checks. | Node.js 20 or newer, pnpm, npm, and registry network access. |
| `pnpm run test:release-gate` | Release-gate contracts and deterministic evidence tests. | Node.js 20 or newer, FFmpeg, and ffprobe. |

Headed Final Cut acceptance remains separate from the native fixture suite.
Use the specific `test:final-cut-*-headed` command only on macOS with Final Cut
Pro and its documented exact-target environment configured; those commands
are not part of ordinary CI or `pnpm run test`.
