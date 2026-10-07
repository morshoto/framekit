#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultAppPath = "/Applications/Final Cut Pro.app";
const plistBuddyPath = "/usr/libexec/PlistBuddy";

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attribute(node, key) {
  const value = node?.[`@${key}`];
  return typeof value === "string" ? value : "";
}

export function parseAppleEventDictionary(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false,
  });
  const dictionary = parser.parse(xml).dictionary ?? {};
  const suites = asArray(dictionary.suite);
  const suiteNames = suites.map((suite) => ({ name: attribute(suite, "name"), code: attribute(suite, "code") }));
  const accessGroups = suites.flatMap((suite) =>
    asArray(suite["access-group"]).map((group) => ({
      suite: attribute(suite, "name"),
      suiteCode: attribute(suite, "code"),
      identifier: attribute(group, "identifier"),
      access: attribute(group, "access"),
    })),
  );
  const commands = suites.flatMap((suite) => asArray(suite.command).map((command) => ({
    suite: attribute(suite, "name"),
    suiteCode: attribute(suite, "code"),
    name: attribute(command, "name"),
    code: attribute(command, "code"),
  })).filter((command) => command.name));
  const classes = suites.flatMap((suite) =>
    asArray(suite.class).map((item) => ({
      suite: attribute(suite, "name"),
      suiteCode: attribute(suite, "code"),
      name: attribute(item, "name"),
      code: attribute(item, "code"),
      properties: asArray(item.property).map((property) => ({
        name: attribute(property, "name"),
        code: attribute(property, "code"),
        type: attribute(property, "type"),
        access: attribute(property, "access") || "read-write-or-unspecified",
      })).filter((property) => property.name),
      elements: asArray(item.element).map((element) => ({
        type: attribute(element, "type"),
        code: attribute(element, "code"),
        access: attribute(element, "access") || "read-write-or-unspecified",
      })).filter((element) => element.type),
    })).filter((item) => item.name),
  );
  const recordTypes = suites.flatMap((suite) => asArray(suite["record-type"]).map((recordType) => ({
    suite: attribute(suite, "name"),
    suiteCode: attribute(suite, "code"),
    name: attribute(recordType, "name"),
    code: attribute(recordType, "code"),
    properties: asArray(recordType.property).map((property) => ({
      name: attribute(property, "name"),
      code: attribute(property, "code"),
      type: attribute(property, "type"),
      access: attribute(property, "access") || "read-write-or-unspecified",
    })).filter((property) => property.name),
  })).filter((recordType) => recordType.name));

  return { suites: suiteNames, accessGroups, commands, classes, recordTypes };
}

function normalized(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function classifySupportedSurfaces(surfaces) {
  const appleEvents = surfaces.appleEvents ?? { commands: [], classes: [] };
  const projectClass = appleEvents.classes.find((item) => normalized(item.name) === "project");
  const sequenceClass = appleEvents.classes.find((item) => normalized(item.name) === "sequence");
  const fieldName = (property) => typeof property === "string" ? property : property.name;
  const projectFields = new Set((projectClass?.properties ?? []).map((property) => normalized(fieldName(property))));
  const sequenceFields = new Set((sequenceClass?.properties ?? []).map((property) => normalized(fieldName(property))));
  const findProperty = (item, name) => (item?.properties ?? []).find((property) =>
    normalized(fieldName(property)) === normalized(name),
  );
  const propertyIsReadOnly = (item, name) => findProperty(item, name)?.access === "r";
  const propertyIsRationalTime = (item, name) => {
    const property = findProperty(item, name);
    const type = normalized(property?.type ?? "");
    return property?.access === "r" && (type.includes("mediatime") || type.includes("rational") || type.includes("cmtime"));
  };
  const elementType = (element) => typeof element === "string" ? element : element.type;
  const elementIsReadOnly = (item, name) => (item?.elements ?? []).some((element) =>
    normalized(elementType(element)) === normalized(name) && typeof element !== "string" && element.access === "r",
  );
  const readOnlyQuery = appleEvents.accessGroups?.some((group) => group.access === "r")
    && appleEvents.commands.some((command) => (command.name ?? command) === "get");
  const readOnlyGroupCovers = (item) => Boolean(item?.suiteCode)
    && appleEvents.accessGroups?.some((group) => group.access === "r" && group.suiteCode === item.suiteCode);
  const projectIdentity = ["id", "name"].every((field) => projectFields.has(field) && propertyIsReadOnly(projectClass, field));
  const sequenceIdentity = ["id", "name"].every((field) => sequenceFields.has(field) && propertyIsReadOnly(sequenceClass, field));
  const projectSequenceRelationship = propertyIsReadOnly(projectClass, "sequence") || elementIsReadOnly(projectClass, "sequence");
  const occurrenceElements = (sequenceClass?.elements ?? []).filter((element) => {
    const type = normalized(elementType(element));
    return (type.includes("occurrence") || type === "timelineclip" || type === "clipoccurrence")
      && typeof element !== "string" && element.access === "r";
  });
  const occurrenceClasses = occurrenceElements.map((element) =>
    appleEvents.classes.find((item) => normalized(item.name) === normalized(elementType(element))),
  );
  const timelineOccurrences = occurrenceElements.length > 0 && occurrenceClasses.every((item) =>
    item && propertyIsReadOnly(item, "id"),
  );
  const exactSequenceTiming = ["start time", "duration", "frame duration"].every((field) =>
    sequenceFields.has(normalized(field)) && propertyIsRationalTime(sequenceClass, field),
  );
  const exactOccurrenceTiming = occurrenceClasses.length > 0 && occurrenceClasses.every((item) =>
    item && ["start time", "duration", "source start", "source duration"].every((field) => propertyIsRationalTime(item, field)),
  );
  const exactTiming = exactSequenceTiming && exactOccurrenceTiming;
  const readOnlyObjectModel = Boolean(projectClass && sequenceClass && occurrenceClasses.length > 0)
    && [projectClass, sequenceClass, ...occurrenceClasses].every(readOnlyGroupCovers);
  const eachOccurrenceHasReadOnlyProperty = (...needles) => occurrenceClasses.length > 0 && occurrenceClasses.every((item) =>
    item && needles.some((needle) => propertyIsReadOnly(item, needle)),
  );
  const mediaResourceBindings = eachOccurrenceHasReadOnlyProperty("resource id", "asset id", "media id", "media identifier");
  const roles = eachOccurrenceHasReadOnlyProperty("role", "roles");
  const storylineRelationships = eachOccurrenceHasReadOnlyProperty("storyline", "lane", "attached to", "spine position");
  // The bridge's local callback counter is inventoried separately; it is not an Apple Event source revision contract.
  const revisionFields = ["revision", "change token", "change sequence", "modification version"];
  const sourceBoundRevision = [projectClass, sequenceClass, ...occurrenceClasses].some((item) =>
    readOnlyGroupCovers(item) && revisionFields.some((field) => propertyIsReadOnly(item, field)),
  );
  const requirements = [
    ["supported read-only query", Boolean(readOnlyQuery)],
    ["timeline objects covered by read-only access", readOnlyObjectModel],
    ["project identity", projectIdentity],
    ["sequence identity", sequenceIdentity],
    ["project-to-sequence relationship", projectSequenceRelationship],
    ["timeline occurrences", timelineOccurrences],
    ["exact occurrence timing", exactTiming],
    ["media/resource bindings", mediaResourceBindings],
    ["roles", roles],
    ["storyline relationships", storylineRelationships],
    ["source-bound revision", sourceBoundRevision],
  ];
  const missingRequirements = requirements.filter(([, satisfied]) => !satisfied).map(([name]) => name);
  const completeSnapshotCandidate = missingRequirements.length === 0;
  const hasMetadataSurface = Boolean(readOnlyQuery)
    || surfaces.workflowExtension?.stateFields?.length > 0;
  const classification = completeSnapshotCandidate
    ? "complete-direct-snapshot-candidate"
    : hasMetadataSurface ? "metadata-only" : "unsupported/unknown";

  return {
    evaluatedSurface: "Apple Event object model",
    classification,
    completeSnapshotCandidate,
    canonicalCapabilityPromoted: false,
    missingRequirements,
    promotionRequirements: [
      "empirically bind project and sequence identity to the active target",
      "prove occurrence collection completeness and exact rational timing",
      "prove stable media/resource bindings and storyline/role coverage",
      "prove a source-bound freshness signal across repeated reads and external edits",
    ],
    reasons: completeSnapshotCandidate
      ? ["Declared surfaces still require target-bound runtime validation before capability promotion."]
      : hasMetadataSurface
        ? ["Declared metadata surfaces do not establish a complete target-bound timeline snapshot."]
        : ["No relevant supported project, sequence, or timeline-read surface was discovered."],
  };
}

function parseHeaderSurface(header) {
  const interfaces = [];
  for (const match of header.matchAll(/@interface\s+([A-Za-z_]\w*)[^\n]*\n([\s\S]*?)@end/g)) {
    const [, name, body] = match;
    const readOnlyProperties = [];
    for (const declaration of body.matchAll(/@property\s*\(([^)]*)\)\s*([^;]+);/g)) {
      if (!declaration[1].includes("readonly")) continue;
      const member = declaration[2].trim().match(/([A-Za-z_]\w*)$/)?.[1];
      if (member) readOnlyProperties.push(member);
    }
    const selectors = [...body.matchAll(/^\s*-\s*\([^)]*\)\s*([A-Za-z_]\w*)/gm)].map((item) => item[1]);
    interfaces.push({ name, readOnlyProperties, selectors });
  }
  const observerBody = header.match(/@protocol\s+FCPXTimelineObserver[^\n]*\n([\s\S]*?)@end/)?.[1] ?? "";
  const observerCallbacks = [...observerBody.matchAll(/^\s*-\s*\([^)]*\)\s*([A-Za-z_]\w*)/gm)].map((item) => item[1]);
  const mutationSelectors = interfaces.flatMap((item) => item.selectors)
    .filter((selector) => ["movePlayheadTo"].includes(selector));
  return { interfaces, observerCallbacks, mutationSelectors };
}

function parseExtensionSurface(source) {
  const protocolVersion = Number(source.match(/private let protocolVersion = (\d+)/)?.[1] ?? 0);
  const stateBody = source.match(/private struct LiveState: Codable \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const stateFields = [...stateBody.matchAll(/^\s+let\s+(\w+)\s*:/gm)].map((item) => item[1]);
  const capabilityBody = source.match(/EditorCapabilities\(([^)]*)\)/)?.[1] ?? "";
  const capabilities = {};
  for (const match of capabilityBody.matchAll(/(\w+):\s*(?:"([^"]*)"|(true|false|-?\d+))/g)) {
    const [, name, stringValue, scalarValue] = match;
    capabilities[name] = stringValue ?? (scalarValue === "true" ? true : scalarValue === "false" ? false : Number(scalarValue));
  }
  return { protocolVersion, stateFields, capabilities };
}

export function parseWorkflowSurface(header, extensionSource) {
  return {
    host: parseHeaderSurface(header),
    ...parseExtensionSurface(extensionSource),
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function readPlistValue(commandRunner, plistPath, key) {
  return commandRunner(plistBuddyPath, ["-c", `Print :${key}`, plistPath]);
}

export async function collectProbeReport({
  appPath = defaultAppPath,
  commandRunner = runCommand,
  hostHeader,
  extensionSource,
} = {}) {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const hostInfoPlist = join(appPath, "Contents", "Frameworks", "ProExtensionHost.framework", "Resources", "Info.plist");
  const [bundleIdentifierResult, versionResult, buildResult, hostVersionResult, appleEventResult, headerResult, extensionResult] = await Promise.allSettled([
    readPlistValue(commandRunner, infoPlist, "CFBundleIdentifier"),
    readPlistValue(commandRunner, infoPlist, "CFBundleShortVersionString"),
    readPlistValue(commandRunner, infoPlist, "CFBundleVersion"),
    readPlistValue(commandRunner, hostInfoPlist, "CFBundleVersion"),
    commandRunner("sdef", [appPath]),
    hostHeader === undefined
      ? readFile(join(repositoryRoot, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/ProExtensionHostShim/ProExtensionHost.h"), "utf8")
      : Promise.resolve(hostHeader),
    extensionSource === undefined
      ? readFile(join(repositoryRoot, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift"), "utf8")
      : Promise.resolve(extensionSource),
  ]);
  const readResult = (result) => result.status === "fulfilled" ? String(result.value).trim() : null;
  const appleEventXml = readResult(appleEventResult);
  const appleEvents = appleEventXml ? parseAppleEventDictionary(appleEventXml) : { accessGroups: [], commands: [], classes: [] };
  const workflowExtension = parseWorkflowSurface(readResult(headerResult) ?? "", readResult(extensionResult) ?? "");
  const supportedSurfaces = { appleEvents, workflowExtension };
  const finalCut = {
    bundleIdentifier: readResult(bundleIdentifierResult),
    version: readResult(versionResult),
    build: readResult(buildResult),
    proExtensionHostVersion: readResult(hostVersionResult),
  };
  const errors = [];
  if (!finalCut.bundleIdentifier || !finalCut.version || !finalCut.build) errors.push("Final Cut bundle metadata was unavailable.");
  if (!finalCut.proExtensionHostVersion) errors.push("The bundled ProExtensionHost version was unavailable.");
  if (!appleEventXml) errors.push("The installed Apple Event dictionary was unavailable.");
  if (!readResult(headerResult)) errors.push("The checked-in ProExtensionHost declarations were unavailable.");
  if (!readResult(extensionResult)) errors.push("The checked-in Workflow Extension source was unavailable.");
  const classification = classifySupportedSurfaces(supportedSurfaces);
  if (errors.length > 0) {
    classification.classification = "unsupported/unknown";
    classification.completeSnapshotCandidate = false;
    classification.canonicalCapabilityPromoted = false;
    classification.reasons = [...errors, ...classification.reasons];
  }
  return { probeVersion: 1, finalCut, supportedSurfaces, classification };
}

function appPathFromArgs(argv) {
  const index = argv.indexOf("--app");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : defaultAppPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await collectProbeReport({ appPath: appPathFromArgs(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.classification.classification === "unsupported/unknown") process.exitCode = 2;
}
