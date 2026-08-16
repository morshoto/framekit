import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const forbidden = [
  ["packages/runtime", /@modelcontextprotocol\/sdk/],
  ["packages/runtime", /@framekit\/final-cut/],
];

async function* typescriptFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* typescriptFiles(file);
    else if (entry.isFile() && file.endsWith(".ts")) yield file;
  }
}

for (const [directory, pattern] of forbidden) {
  for await (const file of typescriptFiles(directory)) {
    const source = await readFile(file, "utf8");
    if (pattern.test(source)) throw new Error(`Boundary violation in ${file}: ${pattern}`);
  }
}

console.log("Framekit package boundaries passed");
