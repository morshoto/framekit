export const MAINTENANCE_RELEASE_SUMMARY = "🧰 Maintenance & Internal";

const MAINTENANCE_HEADING = `### ${MAINTENANCE_RELEASE_SUMMARY}`;

export function collapseMaintenanceReleaseNotes(markdown) {
  if (typeof markdown !== "string") {
    throw new TypeError("release notes must be a string");
  }

  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => line.trimEnd() === MAINTENANCE_HEADING);
  if (headingIndex === -1) {
    return markdown;
  }

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{2,3}\s/.test(line) || /^\*\*Full Changelog\*\*:/.test(line)) {
      endIndex = index;
      break;
    }
  }

  const body = lines.slice(headingIndex + 1, endIndex);
  while (body[0]?.trim() === "") body.shift();
  while (body.at(-1)?.trim() === "") body.pop();

  if (body.length === 0) {
    return markdown;
  }

  const replacement = [
    "<details>",
    `<summary>${MAINTENANCE_RELEASE_SUMMARY}</summary>`,
    "",
    ...body,
    "",
    "</details>",
    "",
  ];

  return [
    ...lines.slice(0, headingIndex),
    ...replacement,
    ...lines.slice(endIndex),
  ].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  process.stdout.write(collapseMaintenanceReleaseNotes(await readStdin()));
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
