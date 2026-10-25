import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageBuildIdentity } from "../apps/mcp-server/src/build-identity.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageManifest = JSON.parse(
	await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
) as { version?: unknown };
if (typeof packageManifest.version !== "string") {
	throw new Error("FRAMEKIT_PACKAGE_VERSION_INVALID");
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: repositoryRoot,
	encoding: "utf8",
}).trim();
const configuredCommit = process.env.FRAMEKIT_BUILD_COMMIT?.trim();
if (configuredCommit && configuredCommit.toLowerCase() !== commit.toLowerCase()) {
	throw new Error("FRAMEKIT_BUILD_COMMIT_MISMATCH: package commit must match the checked out source");
}
const identity = createPackageBuildIdentity(packageManifest.version, commit);
const outputDirectory = resolve(repositoryRoot, "dist-package/apps/mcp-server/src");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
	resolve(outputDirectory, "build-identity.json"),
	`${JSON.stringify(identity, null, 2)}\n`,
	"utf8",
);
process.stderr.write(`Framekit package identity ${identity.version}@${identity.commit}\n`);
