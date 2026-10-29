import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPathPattern = /(?:^|[\s"'`])((?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|py|sh))(?![A-Za-z0-9_./-])/g;
const commandPattern = /\b(?:node|tsx|ts-node|python3?|bash|sh)\b([^\r\n;&|]*)/g;
const directScriptCommandPattern = /(?:^|[\r\n;&|]|\brun\s*:\s*|\bcommand\s*:)\s*((?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|py|sh))(?![A-Za-z0-9_./-])/gm;
const markdownLinkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export async function checkScriptReferences(rootDirectory = repositoryRoot) {
  const issues = [];
  const packagePath = path.join(rootDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    await checkCommandReferences(command, `package.json scripts.${name}`, rootDirectory, issues);
  }
  for (const [name, entrypoint] of Object.entries(packageJson.bin ?? {})) {
    const target = path.resolve(rootDirectory, entrypoint);
    if (!(await isFile(target))) {
      issues.push(`package.json bin.${name} points to missing executable ${entrypoint.replace(/^\.\//, "")}`);
    }
  }

  for (const workflow of await listFiles(path.join(rootDirectory, ".github/workflows"))) {
    if (!/\.ya?ml$/i.test(workflow)) continue;
    const content = await readFile(workflow, "utf8");
    const relativeWorkflow = path.relative(rootDirectory, workflow).split(path.sep).join("/");
    await checkCommandReferences(content, relativeWorkflow, rootDirectory, issues);
  }

  const documents = await listFiles(path.join(rootDirectory, "docs"));
  for (const readme of ["README.md", "tests/README.md"]) {
    const file = path.join(rootDirectory, readme);
    if (await isFile(file)) documents.push(file);
  }
  for (const document of documents) {
    if (!document.endsWith(".md")) continue;
    const content = await readFile(document, "utf8");
    const relativeDocument = path.relative(rootDirectory, document).split(path.sep).join("/");
    await checkCommandReferences(content, relativeDocument, rootDirectory, issues);
    for (const [, href] of content.matchAll(markdownLinkPattern)) {
      const linkPath = href.split("#", 1)[0];
      if (!linkPath || path.isAbsolute(linkPath) || /^[a-z][a-z\d+.-]*:/i.test(linkPath)) continue;
      if (!/(?:^|\/)scripts\//.test(linkPath)) continue;
      const target = path.resolve(path.dirname(document), decodeURIComponent(linkPath));
      if (!(await isFile(target))) {
        issues.push(`${relativeDocument} links to missing script ${linkPath}`);
      }
    }
  }

  return issues.sort();
}

async function checkCommandReferences(content, source, rootDirectory, issues) {
  for (const [, commandArguments] of content.matchAll(commandPattern)) {
    for (const [, scriptPath] of commandArguments.matchAll(scriptPathPattern)) {
      const normalizedPath = scriptPath.replace(/^\.\//, "");
      if (!(await isFile(path.resolve(rootDirectory, normalizedPath)))) {
        issues.push(`${source} runs missing script ${normalizedPath}`);
      }
    }
  }
  for (const [, scriptPath] of content.matchAll(directScriptCommandPattern)) {
    const normalizedPath = scriptPath.replace(/^\.\//, "");
    if (!(await isFile(path.resolve(rootDirectory, normalizedPath)))) {
      issues.push(`${source} runs missing script ${normalizedPath}`);
    }
  }
}

async function listFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const issues = await checkScriptReferences();
  if (issues.length > 0) {
    process.stderr.write(`${issues.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Script references and package entrypoints are valid.\n");
  }
}
