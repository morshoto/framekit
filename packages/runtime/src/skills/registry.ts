import type { SkillDefinition, SkillManifest } from "../domain/skills.js";

export class SkillRegistry {
  private readonly definitions = new Map<string, Map<string, SkillDefinition>>();

  public register(definition: SkillDefinition): void {
    validateManifest(definition.manifest);
    const versions = this.definitions.get(definition.manifest.id) ?? new Map<string, SkillDefinition>();
    if (versions.has(definition.manifest.version)) {
      throw new Error(`SKILL_DUPLICATE: ${definition.manifest.id}@${definition.manifest.version} is already registered`);
    }
    versions.set(definition.manifest.version, definition);
    this.definitions.set(definition.manifest.id, versions);
  }

  public list(): SkillManifest[] {
    return [...this.definitions.values()]
      .flatMap((versions) => [...versions.values()])
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)
        || compareVersions(left.manifest.version, right.manifest.version))
      .map((definition) => structuredClone(definition.manifest));
  }

  public inspect(skillId: string, version?: string): SkillManifest {
    return structuredClone(this.lookup(skillId, version).manifest);
  }

  public lookup(skillId: string, version?: string): SkillDefinition {
    const versions = this.definitions.get(skillId);
    if (!versions) throw new Error(`SKILL_NOT_FOUND: ${skillId}`);
    if (version !== undefined) {
      const definition = versions.get(version);
      if (!definition) throw new Error(`SKILL_VERSION_NOT_FOUND: ${skillId}@${version}`);
      return definition;
    }
    const definition = [...versions.values()].sort((left, right) => compareVersions(right.manifest.version, left.manifest.version))[0];
    if (!definition) throw new Error(`SKILL_NOT_FOUND: ${skillId}`);
    return definition;
  }
}

export function validateManifest(manifest: SkillManifest): void {
  if (manifest.contractVersion !== 1) throw new Error("SKILL_MANIFEST_INVALID: unsupported contract version");
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(manifest.id)) throw new Error("SKILL_MANIFEST_INVALID: id must be stable and non-empty");
  if (!isSemanticVersion(manifest.version)) throw new Error(`SKILL_MANIFEST_INVALID: version ${manifest.version} is not semantic`);
  if (!manifest.title.trim() || !manifest.description.trim()) throw new Error("SKILL_MANIFEST_INVALID: title and description are required");
  if (manifest.inputSchema.type !== "object") throw new Error("SKILL_MANIFEST_INVALID: inputSchema must be an object schema");
}

function isSemanticVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version);
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! - b.numbers[index]!;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function parseVersion(version: string): { numbers: number[]; prerelease?: string } {
  const [core, prerelease] = version.split("-");
  return { numbers: core!.split(".").map(Number), ...(prerelease ? { prerelease } : {}) };
}
