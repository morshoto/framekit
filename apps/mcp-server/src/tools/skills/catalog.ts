import type { SkillToolMetadata } from "./metadata.js";

export interface ListedSkillTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface SkillToolCatalogEntry extends Omit<SkillToolMetadata, "inputSchema"> {
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface SkillToolCatalog {
  schemaVersion: 1;
  tools: SkillToolCatalogEntry[];
}

export interface SkillToolCatalogResult {
  catalog: SkillToolCatalog;
  errors: string[];
}

/** Combine the public tools/list contract with its explicitly declared family metadata. */
export function buildSkillToolCatalog(
  metadata: readonly unknown[],
  listedTools: readonly ListedSkillTool[],
): SkillToolCatalogResult {
  const errors = validateMetadata(metadata);
  const skillTools = listedTools.filter(({ name }) => name.startsWith("skill."));
  const listedByName = new Map<string, ListedSkillTool>();
  for (const tool of skillTools) {
    if (listedByName.has(tool.name)) errors.push(`duplicate tools/list name ${tool.name}`);
    else listedByName.set(tool.name, tool);
  }

  const metadataByName = new Map<string, SkillToolMetadata>();
  for (const entry of metadata) {
    if (!isSkillToolMetadata(entry)) continue;
    metadataByName.set(entry.name, entry);
    const listed = listedByName.get(entry.name);
    if (!listed) {
      errors.push(`${entry.name} missing from tools/list`);
      continue;
    }
    if (listed.description !== entry.description) {
      errors.push(`${entry.name} description drift from tools/list`);
    }
    compareInputContract(entry, listed, errors);
  }

  for (const name of listedByName.keys()) {
    if (!metadataByName.has(name)) errors.push(`${name} missing typed metadata`);
  }

  const catalogTools = metadata.flatMap((entry) => {
    if (!isSkillToolMetadata(entry)) return [];
    const listed = listedByName.get(entry.name);
    if (!listed || !isRecord(listed.inputSchema)) return [];
    const { inputSchema: _schema, ...declaredMetadata } = entry;
    return [{ ...declaredMetadata, inputSchema: structuredClone(listed.inputSchema) }];
  });

  return { catalog: { schemaVersion: 1, tools: catalogTools }, errors };
}

function validateMetadata(metadata: readonly unknown[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const entry of metadata) {
    if (!isRecord(entry)) {
      errors.push("metadata entry must be an object");
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name : undefined;
    if (!name) {
      errors.push("metadata entry missing required field name");
    } else if (names.has(name)) {
      errors.push(`duplicate metadata name ${name}`);
    } else {
      names.add(name);
    }
    if (name && !name.startsWith("skill.")) errors.push(`${name} must use the skill. tool family prefix`);
    if (name && (typeof entry.description !== "string" || !entry.description.trim())) {
      errors.push(`${name} missing required metadata field description`);
    }
    if (name && !isZodRawShape(entry.inputSchema)) errors.push(`${name} missing required metadata field inputSchema`);
    if (name && (typeof entry.outputContract !== "string" || !entry.outputContract.trim())) {
      errors.push(`${name} missing required metadata field outputContract`);
    }
    if (name && !validModes(entry.capabilityModes)) errors.push(`${name} missing required metadata field capabilityModes`);
    if (name && !nonEmptyStringArray(entry.capabilities)) errors.push(`${name} missing required metadata field capabilities`);
    if (name && !["read", "preview", "write"].includes(String(entry.effect))) {
      errors.push(`${name} missing required metadata field effect`);
    }
    if (name && !validApproval(entry.approval)) errors.push(`${name} missing required metadata field approval`);
    if (name && !stringArray(entry.errorCodes)) errors.push(`${name} missing required metadata field errorCodes`);
    if (name && !Array.isArray(entry.examples)) errors.push(`${name} missing required metadata field examples`);
  }
  return errors;
}

function compareInputContract(
  metadata: SkillToolMetadata,
  listed: ListedSkillTool,
  errors: string[],
): void {
  const actualSchema = isRecord(listed.inputSchema) ? listed.inputSchema : {};
  const actualProperties = isRecord(actualSchema.properties) ? Object.keys(actualSchema.properties).sort() : [];
  const expectedProperties = Object.keys(metadata.inputSchema).sort();
  if (!sameStrings(expectedProperties, actualProperties)) {
    errors.push(`${metadata.name} input property drift from tools/list`);
  }

  const expectedRequired = Object.entries(metadata.inputSchema)
    .filter(([, schema]) => !schema.isOptional())
    .map(([name]) => name)
    .sort();
  const actualRequired = Array.isArray(actualSchema.required)
    ? actualSchema.required.filter((item): item is string => typeof item === "string").sort()
    : [];
  if (!sameStrings(expectedRequired, actualRequired)) {
    errors.push(`${metadata.name} required input drift from tools/list`);
  }
}

function isSkillToolMetadata(value: unknown): value is SkillToolMetadata {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.description === "string"
    && isZodRawShape(value.inputSchema)
    && typeof value.outputContract === "string"
    && validModes(value.capabilityModes)
    && nonEmptyStringArray(value.capabilities)
    && ["read", "preview", "write"].includes(String(value.effect))
    && validApproval(value.approval)
    && stringArray(value.errorCodes)
    && Array.isArray(value.examples);
}

function isZodRawShape(value: unknown): value is SkillToolMetadata["inputSchema"] {
  return isRecord(value) && Object.values(value).every((schema) => (
    isRecord(schema) && typeof schema.isOptional === "function"
  ));
}

function validModes(value: unknown): value is SkillToolMetadata["capabilityModes"] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((mode) => ["fixture", "headless", "editor"].includes(String(mode)));
}

function validApproval(value: unknown): value is SkillToolMetadata["approval"] {
  if (!isRecord(value)) return false;
  return value.kind === "none" && value.required === false
    || value.kind === "runtime-preview-token" && value.required === true;
}

function nonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
