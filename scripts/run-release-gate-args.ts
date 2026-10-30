// Compatibility exports; the maintained argument parser lives in scripts/release/.
export {
  parseReleaseGateArgs,
  parseReleaseGateOutputDirectory,
} from "./release/run-release-gate-args.js";
export type { ReleaseGateCliOptions } from "./release/run-release-gate-args.js";
