import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { build } from "esbuild";

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export const FRAMEKIT_PACKAGES = [
  { id: "runtime", name: "@framekit/runtime", root: "packages/runtime", manifest: "packages/runtime/package.json" },
  { id: "testkit", name: "@framekit/testkit", root: "packages/testkit", manifest: "packages/testkit/package.json" },
  { id: "final-cut", name: "@framekit/final-cut", root: "adapters/final-cut/typescript", manifest: "adapters/final-cut/typescript/package.json" },
  { id: "headless-renderer", name: "@framekit/headless-renderer", root: "adapters/headless/typescript", manifest: "adapters/headless/typescript/package.json" },
  { id: "mcp-server", name: "@framekit/mcp-server", root: "apps/mcp-server", manifest: "apps/mcp-server/package.json" },
  // #569 adds this CLI source tree as a workspace package. Until then the root
  // package manifest owns its external dependencies and one workspace edge is exempted below.
  { id: "cli", name: null, root: "apps/cli", manifest: "package.json", sourceRoot: "apps/cli/src" },
];

export const FRAMEKIT_BOUNDARY_POLICY = {
  allowedDependencies: {
    runtime: [],
    testkit: ["runtime"],
    "final-cut": ["runtime"],
    "headless-renderer": ["runtime"],
    "mcp-server": ["runtime", "final-cut", "headless-renderer"],
    cli: ["final-cut"],
  },
  allowedExternalDependencies: {
    runtime: [],
    testkit: [],
    "final-cut": ["fast-xml-parser"],
    "headless-renderer": [],
    "mcp-server": ["@modelcontextprotocol/sdk", "zod"],
    cli: [],
  },
  productionEntrypoints: ["apps/mcp-server/src/main.ts", "apps/cli/src/main.ts"],
  experimentalModules: [
    "adapters/final-cut/typescript/src/sqlite-experiment.ts",
    "adapters/final-cut/typescript/src/sqlite-materialization.ts",
    "adapters/final-cut/typescript/src/shadow-mutation.ts",
    "adapters/final-cut/typescript/src/fcpxml-console-experiment.ts",
    "adapters/final-cut/typescript/src/unattended-editing.ts",
    "adapters/final-cut/typescript/src/pasteboard-snapshot.ts",
  ],
  exceptions: [
    {
      kind: "allowed-package-edge",
      source: "apps/mcp-server/src/main.ts",
      specifier: "@framekit/testkit",
      target: "testkit",
      reason: "The MCP bootstrap retains its deterministic fixture fallback while editor selection is established.",
    },
    {
      kind: "undeclared-workspace-dependency",
      source: "apps/cli/src/main.ts",
      specifier: "@framekit/final-cut",
      target: "final-cut",
      reason: "The CLI remains root-owned until workspace identity and published entrypoints land in #569.",
    },
    {
      kind: "dependency-cycle",
      members: [
        "packages/runtime/src/timeline/editing-session.ts",
        "packages/runtime/src/timeline/drift-reconciliation.ts",
      ],
      reason: "The current Timeline IR edit and reconcile workflows share validation and reconciliation calls; extracting that contract is outside the boundary-check change.",
    },
  ],
};

/**
 * Build and validate the source graph for the provided workspace packages.
 * Returned paths are always repository-relative POSIX paths.
 */
export async function analyzeWorkspaceBoundaries({ rootDir, packages, policy }) {
  const absoluteRoot = resolve(rootDir);
  const workspace = await loadWorkspacePackages(absoluteRoot, packages);
  const sourceFiles = await collectSourceFiles(absoluteRoot, workspace);
  const tsconfig = await loadTsconfig(absoluteRoot, "tsconfig.json");
  const result = await buildImportMetadata(absoluteRoot, sourceFiles, tsconfig);
  const violations = [];
  const edges = [];
  const sourceOwners = new Map(sourceFiles.map((file) => [file.path, file.owner]));
  const importEdgesBySource = new Map(sourceFiles.map((file) => [file.path, []]));
  const importsBySource = new Map(sourceFiles.map((file) => [file.path, []]));

  for (const [inputPath, input] of Object.entries(result.metafile.inputs)) {
    const sourcePath = toRootRelative(absoluteRoot, inputPath);
    if (importsBySource.has(sourcePath)) importsBySource.get(sourcePath).push(...input.imports);
  }

  for (const file of sourceFiles) {
    const imports = importsBySource.get(file.path);
    const knownSpecifiers = new Set(imports.map((imported) => imported.original ?? imported.path));
    const source = await readFile(resolve(absoluteRoot, file.path), "utf8");
    for (const specifier of collectStaticModuleSpecifiers(file.path, source)) {
      if (knownSpecifiers.has(specifier)) continue;
      knownSpecifiers.add(specifier);
      imports.push({ path: specifier, external: true, boundaryOnly: true });
    }
  }

  for (const [sourcePath, imports] of importsBySource) {
    const sourceOwner = sourceOwners.get(sourcePath);
    for (const imported of imports) {
      const specifier = imported.original ?? imported.path;
      const sourceAbsolute = resolve(absoluteRoot, sourcePath);
      const resolved = resolveImport({
        rootDir: absoluteRoot,
        sourceAbsolute,
        specifier,
        imported,
        tsconfig,
        workspace,
      });

      if (resolved.error) {
        violations.push(violation(resolved.code, sourcePath, `${specifier}: ${resolved.error}`));
        continue;
      }

      if (resolved.targetPath) {
        const targetOwner = ownerForFile(workspace, resolve(absoluteRoot, resolved.targetPath));
        if (!targetOwner) {
          violations.push(violation("unowned-source-import", sourcePath, `${specifier} resolves outside a declared source package (${resolved.targetPath})`));
          continue;
        }

        const edge = {
          source: sourcePath,
          target: resolved.targetPath,
          specifier,
          from: sourceOwner.id,
          to: targetOwner.id,
          kind: resolved.kind,
        };
        edges.push(edge);
        if (!imported.boundaryOnly) importEdgesBySource.get(sourcePath).push(edge);

        if (sourceOwner.id !== targetOwner.id) {
          if (resolved.kind === "relative") {
            violations.push(violation("relative-cross-package", sourcePath, `${specifier} crosses from ${sourceOwner.id} into ${targetOwner.id}; import its public workspace entrypoint`));
          }
          if (!policy.allowedDependencies[sourceOwner.id]?.includes(targetOwner.id)
              && !hasException(policy, "allowed-package-edge", edge)) {
            violations.push(violation("forbidden-dependency", sourcePath, `${sourceOwner.id} may not depend on ${targetOwner.id} through ${specifier}`));
          }
          if (!isDeclared(sourceOwner.manifest, targetOwner.name)
              && !hasException(policy, "undeclared-workspace-dependency", edge)) {
            violations.push(violation("undeclared-dependency", sourcePath, `${sourceOwner.id} does not declare workspace package ${targetOwner.name}`));
          }
        }
        continue;
      }

      if (NODE_BUILTINS.has(specifier)) continue;
      const externalName = packageNameFromSpecifier(specifier);
      if (!policy.allowedExternalDependencies[sourceOwner.id]?.includes(externalName)) {
        violations.push(violation("forbidden-external-dependency", sourcePath, `${sourceOwner.id} may not depend on external package ${externalName}`));
      } else if (!isDeclared(sourceOwner.manifest, externalName)) {
        violations.push(violation("undeclared-dependency", sourcePath, `${sourceOwner.id} does not declare external package ${externalName}`));
      }
    }
  }

  const runtimeCycles = findRuntimeCycles(absoluteRoot, result.metafile, sourceOwners, workspace, tsconfig, policy);
  for (const cycle of runtimeCycles) {
    if (!hasCycleException(policy, cycle)) {
      violations.push(violation("dependency-cycle", cycle[0], cycle.join(" -> ")));
    }
  }

  for (const entrypoint of policy.productionEntrypoints) {
    if (!sourceOwners.has(entrypoint)) {
      violations.push(violation("missing-production-entrypoint", entrypoint, "Production entrypoint is not in a declared source package"));
      continue;
    }
    for (const target of reachableFiles(entrypoint, importEdgesBySource)) {
      if (policy.experimentalModules.includes(target)) {
        violations.push(violation("experimental-production-import", entrypoint, `Default production wiring reaches experimental module ${target}`));
      }
    }
  }

  violations.sort((left, right) => left.code.localeCompare(right.code)
    || left.source.localeCompare(right.source)
    || left.message.localeCompare(right.message));
  edges.sort((left, right) => left.source.localeCompare(right.source)
    || left.specifier.localeCompare(right.specifier)
    || left.target.localeCompare(right.target));
  return { violations, edges };
}

function collectStaticModuleSpecifiers(filePath, source) {
  const extension = extname(filePath);
  const plugins = [".ts", ".tsx", ".mts", ".cts"].includes(extension) ? ["typescript"] : [];
  if ([".tsx", ".jsx"].includes(extension)) plugins.push("jsx");
  const file = parse(source, { sourceType: "unambiguous", plugins, attachComment: false });
  const specifiers = new Set();

  const visit = (node) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
        && node.source?.type === "StringLiteral") {
      specifiers.add(node.source.value);
    } else if (node.type === "TSImportEqualsDeclaration"
        && node.moduleReference?.type === "TSExternalModuleReference"
        && node.moduleReference.expression?.type === "StringLiteral") {
      specifiers.add(node.moduleReference.expression.value);
    } else if (node.type === "TSImportType" && node.argument?.type === "StringLiteral") {
      specifiers.add(node.argument.value);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  };
  visit(file);
  return specifiers;
}

async function buildImportMetadata(rootDir, sourceFiles, tsconfig) {
  const entryPoints = Object.fromEntries(sourceFiles.map((file, index) => [`source-${index}`, resolve(rootDir, file.path)]));
  try {
    const result = await build({
      absWorkingDir: rootDir,
      entryPoints,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      metafile: true,
      logLevel: "silent",
      outdir: resolve(rootDir, ".framekit-boundary-check"),
      tsconfig: resolve(rootDir, "tsconfig.json"),
      plugins: [externalizeBareModules(tsconfig)],
    });
    return result;
  } catch (error) {
    throw new Error(`Unable to resolve the workspace import graph: ${error.message}`, { cause: error });
  }
}

function externalizeBareModules(tsconfig) {
  return {
    name: "framekit-workspace-imports",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith(".") || args.path.startsWith("/")) return undefined;
        const alias = resolveTsPathAlias(args.path, tsconfig);
        if (alias) return { path: alias };
        return { path: args.path, external: true };
      });
    },
  };
}

async function loadWorkspacePackages(rootDir, packages) {
  const loaded = [];
  for (const definition of packages) {
    const root = resolve(rootDir, definition.root);
    const sourceRoot = resolve(rootDir, definition.sourceRoot ?? join(definition.root, "src"));
    const manifestPath = resolve(rootDir, definition.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    loaded.push({ ...definition, root, sourceRoot, manifestPath, manifest });
  }
  return loaded.sort((left, right) => right.sourceRoot.length - left.sourceRoot.length);
}

async function collectSourceFiles(rootDir, packages) {
  const sourceFiles = [];
  for (const owner of packages) {
    if (!existsSync(owner.sourceRoot)) continue;
    for (const absolutePath of await walkSourceFiles(owner.sourceRoot)) {
      const path = toRootRelative(rootDir, absolutePath);
      sourceFiles.push({ path, owner });
    }
  }
  return sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkSourceFiles(absolutePath));
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name)) && !entry.name.endsWith(".d.ts")) files.push(absolutePath);
  }
  return files;
}

async function loadTsconfig(rootDir, fileName) {
  const configPath = resolve(rootDir, fileName);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const inherited = config.extends
    ? await loadTsconfig(dirname(configPath), config.extends)
    : { baseUrl: rootDir, paths: [] };
  const options = config.compilerOptions ?? {};
  const baseUrl = options.baseUrl === undefined
    ? inherited.baseUrl
    : resolve(dirname(configPath), options.baseUrl);
  return {
    baseUrl,
    paths: options.paths === undefined ? inherited.paths : Object.entries(options.paths).map(([pattern, targets]) => ({
      pattern,
      targets: Array.isArray(targets) ? targets : [targets],
      baseUrl,
    })),
  };
}

function resolveImport({ rootDir, sourceAbsolute, specifier, imported, tsconfig, workspace }) {
  if (!imported.external) {
    const targetAbsolute = isAbsolute(imported.path) ? imported.path : resolve(rootDir, imported.path);
    const packageTarget = findWorkspacePackage(workspace, specifier);
    if (packageTarget) {
      const publicTarget = resolveWorkspaceExport(rootDir, packageTarget.package, specifier);
      if (!publicTarget) {
        return { code: "unexported-entrypoint", error: `${specifier} is not declared in ${packageTarget.package.name}'s exports map` };
      }
      if (resolve(targetAbsolute) !== resolve(publicTarget)) {
        return { code: "unexported-entrypoint", error: `TypeScript alias ${specifier} resolves to ${toRootRelative(rootDir, targetAbsolute)}, not its public export ${toRootRelative(rootDir, publicTarget)}` };
      }
      return { targetPath: toRootRelative(rootDir, publicTarget), kind: "package" };
    }
    const targetOwner = ownerForFile(workspace, targetAbsolute);
    if (targetOwner && !specifier.startsWith(".")) {
      return { code: "unexported-entrypoint", error: `${specifier} reaches ${targetOwner.name ?? targetOwner.id} through a non-public module specifier` };
    }
    return { targetPath: toRootRelative(rootDir, targetAbsolute), kind: specifier.startsWith(".") ? "relative" : "resolved" };
  }

  if (specifier.startsWith(".")) {
    const relativeTarget = resolveSourcePath(resolve(dirname(sourceAbsolute), specifier));
    if (relativeTarget) return { targetPath: toRootRelative(rootDir, relativeTarget), kind: "relative" };
    return { code: "unresolved-import", error: "relative TypeScript import does not resolve to a source file" };
  }

  const aliasTarget = resolveTsPathAlias(specifier, tsconfig);
  const workspaceTarget = findWorkspacePackage(workspace, specifier);
  if (aliasTarget && workspaceTarget) {
    const publicTarget = resolveWorkspaceExport(rootDir, workspaceTarget.package, specifier);
    if (!publicTarget) {
      return { code: "unexported-entrypoint", error: `${specifier} is not declared in ${workspaceTarget.package.name}'s exports map` };
    }
    if (resolve(aliasTarget) !== resolve(publicTarget)) {
      return { code: "unexported-entrypoint", error: `TypeScript alias ${specifier} resolves to ${toRootRelative(rootDir, aliasTarget)}, not its public export ${toRootRelative(rootDir, publicTarget)}` };
    }
    return { targetPath: toRootRelative(rootDir, publicTarget), kind: "package" };
  }

  if (workspaceTarget) {
    const publicTarget = resolveWorkspaceExport(rootDir, workspaceTarget.package, specifier);
    if (!publicTarget) {
      return { code: "unexported-entrypoint", error: `${specifier} is not declared in ${workspaceTarget.package.name}'s exports map` };
    }
    return { targetPath: toRootRelative(rootDir, publicTarget), kind: "package" };
  }

  if (aliasTarget) {
    const targetOwner = ownerForFile(workspace, aliasTarget);
    if (targetOwner) {
      return { code: "unexported-entrypoint", error: `${specifier} reaches ${targetOwner.name ?? targetOwner.id} through a non-public TypeScript alias` };
    }
    return { targetPath: toRootRelative(rootDir, aliasTarget), kind: "alias" };
  }

  return { external: packageNameFromSpecifier(specifier) };
}

function resolveTsPathAlias(specifier, tsconfig) {
  for (const mapping of tsconfig.paths) {
    const capture = matchPathPattern(mapping.pattern, specifier);
    if (capture === undefined) continue;
    for (const target of mapping.targets) {
      const substituted = target.replaceAll("*", () => capture);
      const candidate = resolveSourcePath(resolve(mapping.baseUrl, substituted));
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function matchPathPattern(pattern, specifier) {
  const wildcardAt = pattern.indexOf("*");
  if (wildcardAt < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcardAt);
  const suffix = pattern.slice(wildcardAt + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
}

function resolveWorkspaceExport(rootDir, workspacePackage, specifier) {
  const subpath = specifier === workspacePackage.name ? "." : `.${specifier.slice(workspacePackage.name.length)}`;
  const target = findExportTarget(workspacePackage.manifest.exports, subpath);
  return typeof target === "string" ? resolveSourcePath(resolve(workspacePackage.root, target)) : undefined;
}

function findExportTarget(exportsMap, requestedSubpath) {
  if (typeof exportsMap === "string") return requestedSubpath === "." ? exportsMap : undefined;
  if (!exportsMap || typeof exportsMap !== "object") return undefined;

  if (Object.hasOwn(exportsMap, requestedSubpath)) return firstConditionTarget(exportsMap[requestedSubpath]);
  if (Object.keys(exportsMap).some((key) => key.startsWith("."))) {
    for (const [key, value] of Object.entries(exportsMap)) {
      const capture = matchPathPattern(key, requestedSubpath);
      if (capture !== undefined && key.includes("*")) {
        const target = firstConditionTarget(value);
        return typeof target === "string" ? target.replaceAll("*", () => capture) : undefined;
      }
    }
    return undefined;
  }
  return requestedSubpath === "." ? firstConditionTarget(exportsMap) : undefined;
}

function firstConditionTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["types", "import", "node", "default", "require"]) {
    if (Object.hasOwn(value, key)) {
      const target = firstConditionTarget(value[key]);
      if (target) return target;
    }
  }
  return undefined;
}

function resolveSourcePath(candidate) {
  const extension = extname(candidate);
  const sourceAlternatives = extension === ".js"
    ? [candidate.slice(0, -3) + ".ts", candidate.slice(0, -3) + ".tsx", candidate]
    : extension === ".mjs"
      ? [candidate.slice(0, -4) + ".mts", candidate]
      : extension === ".cjs"
        ? [candidate.slice(0, -4) + ".cts", candidate]
        : [candidate, ...SOURCE_EXTENSIONS.map((suffix) => `${candidate}${suffix}`)];
  for (const sourcePath of [...sourceAlternatives, join(candidate, "index.ts"), join(candidate, "index.tsx")]) {
    if (existsSync(sourcePath)) return resolve(sourcePath);
  }
  return undefined;
}

function findWorkspacePackage(workspace, specifier) {
  return workspace
    .filter((candidate) => candidate.name && (specifier === candidate.name || specifier.startsWith(`${candidate.name}/`)))
    .sort((left, right) => right.name.length - left.name.length)
    .map((candidate) => ({ package: candidate, specifier }))[0];
}

function ownerForFile(workspace, absolutePath) {
  const canonicalPath = resolve(absolutePath);
  return workspace.find(({ sourceRoot }) => canonicalPath === sourceRoot || canonicalPath.startsWith(`${sourceRoot}${sep}`));
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function isDeclared(owner, packageName) {
  return ["dependencies", "peerDependencies", "optionalDependencies"].some((section) => Object.hasOwn(owner?.[section] ?? {}, packageName));
}

function hasException(policy, kind, edge) {
  return policy.exceptions.some((exception) => exception.kind === kind
    && exception.source === edge.source
    && exception.specifier === edge.specifier
    && exception.target === edge.to);
}

function hasCycleException(policy, cycle) {
  const actual = [...cycle].sort();
  return policy.exceptions.some((exception) => exception.kind === "dependency-cycle"
    && JSON.stringify([...exception.members].sort()) === JSON.stringify(actual));
}

function findRuntimeCycles(rootDir, metafile, sourceOwners, workspace, tsconfig) {
  const graph = new Map([...sourceOwners.keys()].map((path) => [path, new Set()]));
  for (const output of Object.values(metafile.outputs)) {
    if (!output.entryPoint) continue;
    const entryPath = toRootRelative(rootDir, output.entryPoint);
    const entryOwner = sourceOwners.get(entryPath);
    if (!entryOwner) continue;

    for (const inputPath of Object.keys(output.inputs)) {
      const targetPath = toRootRelative(rootDir, inputPath);
      if (targetPath !== entryPath && sourceOwners.has(targetPath)) graph.get(entryPath).add(targetPath);
    }

    for (const imported of output.imports) {
      if (!imported.external) continue;
      const specifier = imported.path;
      const aliasTarget = resolveTsPathAlias(specifier, tsconfig);
      const packageTarget = findWorkspacePackage(workspace, specifier);
      const target = aliasTarget ?? (packageTarget ? resolveWorkspaceExport(rootDir, packageTarget.package, specifier) : undefined);
      if (target) {
        const targetPath = toRootRelative(rootDir, target);
        if (sourceOwners.has(targetPath) && targetPath !== entryPath) graph.get(entryPath).add(targetPath);
      }
    }
  }
  return stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1 || graph.get(component[0]).has(component[0]))
    .map((component) => component.sort());
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const visit = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };

  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return components;
}

function reachableFiles(entrypoint, edgesBySource) {
  const visited = new Set();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of edgesBySource.get(current) ?? []) pending.push(edge.target);
  }
  visited.delete(entrypoint);
  return visited;
}

function toRootRelative(rootDir, filePath) {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(rootDir, filePath);
  return relative(rootDir, absolutePath).split(sep).join("/");
}

function violation(code, source, message) {
  return { code, source, message };
}
