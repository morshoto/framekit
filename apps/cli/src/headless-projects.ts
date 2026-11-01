import {
  HeadlessProjectService,
  type HeadlessProjectServiceOptions,
  type HeadlessProjectWorkflow,
} from "@framekit/headless-application";

/** Creates the shared headless workflow for CLI-owned operations. */
export function createCliHeadlessProjectService(
  options: HeadlessProjectServiceOptions,
): HeadlessProjectWorkflow {
  return new HeadlessProjectService(options);
}
