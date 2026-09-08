import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import matter from "gray-matter";

import type { CapabilityCard, CapabilityStatus } from "@/components";

export type Locale = "en" | "ja";
export type WikiSection = "product" | "use-cases" | "learn" | "docs" | "blog";

export type WikiFrontmatter = {
  title: string;
  description: string;
  translationKey: string;
  locale: Locale;
  section: WikiSection;
  slug: string;
  eyebrow?: string;
  keywords?: string[];
  primaryLabel?: string;
  primaryHref?: string;
  secondaryLabel?: string;
  secondaryHref?: string;
  status: "draft" | "published";
};

export type WikiPage = {
  frontmatter: WikiFrontmatter;
  body: string;
};

type CapabilitySource = {
  id: string;
  status: CapabilityStatus;
  source: string;
  title: Record<Locale, string>;
  description: Record<Locale, string>;
};

const wikiRoot = resolve(process.cwd(), "../../wiki");

function assertString(value: unknown, key: string, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}: frontmatter field ${key} must be a non-empty string`);
  }
}

function parseFrontmatter(data: Record<string, unknown>, path: string): WikiFrontmatter {
  for (const key of ["title", "description", "translationKey", "locale", "section", "slug", "status"] as const) {
    assertString(data[key], key, path);
  }

  if (data.locale !== "en" && data.locale !== "ja") {
    throw new Error(`${path}: unsupported locale ${data.locale}`);
  }
  const sections: readonly unknown[] = ["product", "use-cases", "learn", "docs", "blog"];
  if (!sections.includes(data.section)) {
    throw new Error(`${path}: unsupported section ${data.section}`);
  }
  if (data.status !== "draft" && data.status !== "published") {
    throw new Error(`${path}: unsupported publication status ${data.status}`);
  }

  const optionalStrings = [
    "eyebrow",
    "primaryLabel",
    "primaryHref",
    "secondaryLabel",
    "secondaryHref",
  ] as const;
  for (const key of optionalStrings) {
    if (data[key] !== undefined && typeof data[key] !== "string") {
      throw new Error(`${path}: frontmatter field ${key} must be a string`);
    }
  }
  if (data.keywords !== undefined && !(
    Array.isArray(data.keywords) && data.keywords.every((keyword) => typeof keyword === "string")
  )) {
    throw new Error(`${path}: frontmatter field keywords must be a string array`);
  }

  return data as WikiFrontmatter;
}

export async function readWikiPage(
  locale: Locale,
  section: WikiSection,
  fileName: string,
): Promise<WikiPage> {
  const path = resolve(wikiRoot, locale, section, `${fileName}.md`);
  const parsed = matter(await readFile(path, "utf8"));
  const frontmatter = parseFrontmatter(parsed.data, path);

  if (frontmatter.locale !== locale || frontmatter.section !== section) {
    throw new Error(`${path}: path and frontmatter locale/section must match`);
  }

  return { frontmatter, body: parsed.content.trim() };
}

export async function readCapabilities(locale: Locale): Promise<CapabilityCard[]> {
  const path = resolve(wikiRoot, "_data/capabilities.json");
  const capabilities = JSON.parse(await readFile(path, "utf8")) as CapabilitySource[];

  return capabilities.map((capability) => ({
    id: capability.id,
    status: capability.status,
    source: capability.source,
    title: capability.title[locale],
    description: capability.description[locale],
  }));
}
