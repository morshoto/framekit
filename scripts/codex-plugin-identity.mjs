import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const pluginIdentitySources = new Set([
  "installed-content-equals-clean-source",
  "installed-content-equals-dirty-source",
  "installed-content-differs-from-source",
]);

export async function inspectInstalledCodexPlugin({
  installedPath,
  sourcePath,
  codexHome,
  version,
  sourceCommit,
  sourceClean,
}) {
  if (!installedPath || !sourcePath || !codexHome || !version || !/^[0-9a-f]{40}$/i.test(sourceCommit ?? "")) {
    throw new Error("CODEX_PLUGIN_IDENTITY_INPUT_INVALID: installed path, source path, Codex home, version, and source commit are required");
  }
  if (typeof sourceClean !== "boolean") {
    throw new Error("CODEX_PLUGIN_IDENTITY_INPUT_INVALID: source cleanliness must be explicit");
  }

  const codexHomePath = await realpath(codexHome);
  const installedPluginPath = await realpath(installedPath);
  if (!isChildPath(codexHomePath, installedPluginPath)) {
    throw new Error("CODEX_PLUGIN_INSTALL_PATH_INVALID: installed plugin path is outside the isolated Codex home");
  }

  const sourcePluginPath = await realpath(sourcePath);
  const [installedManifest, sourceManifest, contentDigest, sourceContentDigest] = await Promise.all([
    readPluginManifest(installedPluginPath),
    readPluginManifest(sourcePluginPath),
    digestCodexPluginDirectory(installedPluginPath),
    digestCodexPluginDirectory(sourcePluginPath),
  ]);
  for (const [label, manifest] of [["installed", installedManifest], ["source", sourceManifest]]) {
    if (manifest.name !== "framekit" || manifest.version !== version) {
      throw new Error(`CODEX_PLUGIN_IDENTITY_MISMATCH: ${label} plugin manifest does not match Framekit ${version}`);
    }
  }

  const matchesSource = contentDigest === sourceContentDigest;
  const identitySource = matchesSource
    ? sourceClean ? "installed-content-equals-clean-source" : "installed-content-equals-dirty-source"
    : "installed-content-differs-from-source";
  const identity = {
    version,
    identitySource,
    contentDigest,
    sourceContentDigest,
  };
  if (matchesSource && sourceClean) {
    const commit = sourceCommit.toLowerCase();
    return { ...identity, commit, sourceCommit: commit };
  }
  return identity;
}

export async function digestCodexPluginDirectory(directory) {
  const root = await realpath(directory);
  const entries = [];
  await collectPluginFiles(root, root, entries);
  if (entries.length === 0) {
    throw new Error("CODEX_PLUGIN_CONTENT_EMPTY: plugin directory contains no regular files");
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function isInstalledCodexPluginBoundToCandidate(plugin, expectedSourceDigest, expectedCommit) {
  return Boolean(
    plugin
    && plugin.identitySource === "installed-content-equals-clean-source"
    && isDigest(plugin.contentDigest)
    && isDigest(plugin.sourceContentDigest)
    && plugin.contentDigest === plugin.sourceContentDigest
    && plugin.sourceContentDigest === expectedSourceDigest
    && isCommit(plugin.commit)
    && isCommit(plugin.sourceCommit)
    && plugin.commit.toLowerCase() === expectedCommit?.toLowerCase()
    && plugin.sourceCommit.toLowerCase() === expectedCommit?.toLowerCase(),
  );
}

export function isCodexPluginIdentitySource(value) {
  return pluginIdentitySources.has(value);
}

async function collectPluginFiles(root, directory, entries) {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const path = join(directory, child.name);
    if (child.isDirectory()) {
      await collectPluginFiles(root, path, entries);
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`CODEX_PLUGIN_CONTENT_UNSUPPORTED: plugin contains a non-regular entry ${relative(root, path)}`);
    }
    const content = await readFile(path);
    entries.push({
      path: relative(root, path).split(sep).join("/"),
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
}

async function readPluginManifest(directory) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, ".codex-plugin", "plugin.json"), "utf8"));
  } catch (error) {
    throw new Error(`CODEX_PLUGIN_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  return manifest && typeof manifest === "object" ? manifest : {};
}

function isChildPath(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
