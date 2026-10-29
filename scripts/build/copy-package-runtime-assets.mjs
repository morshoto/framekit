import { chmod, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = path.join(repositoryRoot, "apps/mcp-server/runtime");
const packageDirectory = path.join(repositoryRoot, "dist-package/apps/mcp-server/runtime");

await rm(packageDirectory, { recursive: true, force: true });
await mkdir(packageDirectory, { recursive: true });
for (const executable of ["speech-analyzer-wrapper.mjs", "whisper-speech-backend.py"]) {
  await cp(path.join(sourceDirectory, executable), path.join(packageDirectory, executable));
  await chmod(path.join(packageDirectory, executable), 0o755);
}
