import { fileURLToPath } from "node:url";
import { analyzeWorkspaceBoundaries, FRAMEKIT_BOUNDARY_POLICY, FRAMEKIT_PACKAGES } from "./boundary-policy.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { violations, edges } = await analyzeWorkspaceBoundaries({
  rootDir,
  packages: FRAMEKIT_PACKAGES,
  policy: FRAMEKIT_BOUNDARY_POLICY,
});

if (violations.length > 0) {
  for (const item of violations) console.error(`[${item.code}] ${item.source}: ${item.message}`);
  process.exitCode = 1;
} else {
  console.log(`Framekit import boundaries passed (${edges.length} resolved source edges)`);
}
