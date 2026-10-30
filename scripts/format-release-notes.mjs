export const MAINTENANCE_RELEASE_SUMMARY = "Maintenance and internal";
export const FORMATTED_RELEASE_NOTES_MARKER = "<!-- Framekit formatted release notes -->";

const MAINTENANCE_HEADING = `### ${MAINTENANCE_RELEASE_SUMMARY}`;
const RELEASE_CATEGORIES = ["New Features", "Bug Fixes", "Documentation", "Chores"];

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

function parsePullRequestEntry(line) {
  const linkMatch = line.match(
    /https?:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+)/i,
  );
  if (!linkMatch || linkMatch.index === undefined) return undefined;

  const attribution = line
    .slice(0, linkMatch.index)
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+in\s*$/, "")
    .trim();
  const authorIndex = attribution.lastIndexOf(" by @");
  const title = (authorIndex < 0 ? attribution : attribution.slice(0, authorIndex)).trim();
  const author = authorIndex < 0
    ? ""
    : attribution.slice(authorIndex + " by @".length).trim().split(/\s+/, 1)[0];

  if (!title) return undefined;
  return {
    number: Number(linkMatch[1]),
    title,
    author,
    url: linkMatch[0],
  };
}

function categoryForEntry(entry, sourceHeading) {
  const type = entry.title.match(/^\s*([a-z][a-z0-9_-]*)(?:\([^)]*\))?:/i)?.[1]?.toLowerCase();
  if (["feat", "feature"].includes(type)) return "New Features";
  if (["fix", "bug"].includes(type)) return "Bug Fixes";
  if (["doc", "docs", "documentation"].includes(type)) return "Documentation";
  if (["chore", "perf", "test", "refactor", "build", "ci", "style", "infra"].includes(type)) {
    return "Chores";
  }

  const normalizedHeading = sourceHeading.trim().toLowerCase();
  if (["new features", "feature changes"].includes(normalizedHeading)) return "New Features";
  if (["bug fixes", "patch changes"].includes(normalizedHeading)) return "Bug Fixes";
  if (normalizedHeading === "documentation") return "Documentation";
  return "Chores";
}

function escapeMarkdownText(text) {
  return text.replace(/([\\`*_{}\[\]()<>|])/g, "\\$1");
}

function findFullChangelog(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*\*\*Full Changelog\*\*:\s*(https?:\/\/\S+)\s*$/);
    if (match) return { index, url: match[1] };
  }
  return undefined;
}

export function formatReleaseNotes(markdown) {
  if (typeof markdown !== "string") {
    throw new TypeError("release notes must be a string");
  }
  if (markdown.includes(FORMATTED_RELEASE_NOTES_MARKER)) return markdown;

  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const whatChangedIndex = lines.findIndex((line) => /^##\s+What's Changed\s*$/i.test(line));
  const compare = findFullChangelog(lines);
  if (whatChangedIndex < 0 || !compare || compare.index <= whatChangedIndex) return normalized;

  const entries = [];
  const extraLines = [];
  let heading = "";
  let inHtmlComment = false;
  for (const line of lines.slice(whatChangedIndex + 1, compare.index)) {
    const headingMatch = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (headingMatch) {
      heading = headingMatch[1];
      if (heading.toLowerCase() === "new contributors") extraLines.push(line);
      continue;
    }

    if (heading.toLowerCase() === "new contributors") {
      extraLines.push(line);
      continue;
    }

    if (inHtmlComment || line.includes("<!--")) {
      extraLines.push(line);
      if (line.includes("-->")) inHtmlComment = false;
      else inHtmlComment = true;
      continue;
    }

    const entry = parsePullRequestEntry(line);
    if (entry) entries.push({ ...entry, sourceHeading: heading });
    else if (line.trim() && !/^<\/?details>|^<summary>|^<\/summary>/.test(line.trim())) {
      extraLines.push(line);
    }
  }

  const uniqueEntries = [...new Map(entries.map((entry) => [entry.number, entry])).values()];
  const grouped = new Map(RELEASE_CATEGORIES.map((category) => [category, []]));
  for (const entry of uniqueEntries) {
    grouped.get(categoryForEntry(entry, entry.sourceHeading)).push(entry);
  }

  const preamble = lines.slice(0, whatChangedIndex).join("\n").trimEnd();
  const output = [];
  if (preamble) output.push(preamble, "");
  output.push(FORMATTED_RELEASE_NOTES_MARKER, "");

  for (const category of RELEASE_CATEGORIES) {
    const categoryEntries = grouped.get(category);
    if (categoryEntries.length === 0) continue;
    output.push(`## ${category}`, "");
    for (const entry of categoryEntries) {
      output.push(`* ${escapeMarkdownText(entry.title)} ([#${entry.number}](${entry.url}))`);
    }
    output.push("");
  }

  output.push("## Changelog", "");
  for (const entry of uniqueEntries) {
    const author = entry.author ? ` — @${escapeMarkdownText(entry.author)}` : "";
    output.push(`* [#${entry.number}](${entry.url}) ${escapeMarkdownText(entry.title)}${author}`);
  }

  const extras = extraLines.join("\n").trim();
  if (extras) output.push("", extras);
  output.push("", `**Full Changelog**: ${compare.url}`);

  const suffix = lines.slice(compare.index + 1).join("\n").trim();
  if (suffix) output.push("", suffix);

  return `${output.join("\n").trimEnd()}${normalized.endsWith("\n") ? "\n" : ""}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  process.stdout.write(formatReleaseNotes(await readStdin()));
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
