import type { Metadata } from "next";

import type { WikiFrontmatter } from "./wiki";

export const siteUrl = "https://framekit.dev";

function absoluteUrl(path: string): string {
  const normalized = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
  return new URL(normalized, siteUrl).toString();
}

export function buildPageMetadata(
  page: WikiFrontmatter,
  localizedPaths: { en: string; ja: string },
): Metadata {
  const canonical = absoluteUrl(page.slug);
  const title = page.translationKey === "home" ? `${page.title} | FrameKit` : `${page.title} | FrameKit`;

  return {
    title,
    description: page.description,
    keywords: page.keywords,
    alternates: {
      canonical,
      languages: {
        en: absoluteUrl(localizedPaths.en),
        ja: absoluteUrl(localizedPaths.ja),
        "x-default": absoluteUrl(localizedPaths.en),
      },
    },
    openGraph: {
      type: page.section === "learn" || page.section === "blog" ? "article" : "website",
      url: canonical,
      title,
      description: page.description,
      siteName: "FrameKit",
      locale: page.locale === "ja" ? "ja_JP" : "en_US",
      images: [{ url: "/og.svg", width: 1200, height: 630, alt: "FrameKit — AI meets Final Cut Pro" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: page.description,
      images: ["/og.svg"],
    },
  };
}

export function buildJsonLd(page: WikiFrontmatter): Record<string, unknown>[] {
  const isArticle = page.section === "learn" || page.section === "blog" || page.section === "docs";
  const pageUrl = absoluteUrl(page.slug);

  const primary = isArticle
    ? {
        "@context": "https://schema.org",
        "@type": page.section === "docs" ? "TechArticle" : "Article",
        headline: page.title,
        description: page.description,
        inLanguage: page.locale,
        mainEntityOfPage: pageUrl,
        publisher: { "@type": "Organization", name: "FrameKit", url: siteUrl },
      }
    : {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "FrameKit",
        applicationCategory: "MultimediaApplication",
        operatingSystem: "macOS",
        description: page.description,
        url: pageUrl,
        isAccessibleForFree: true,
        codeRepository: "https://github.com/morshoto/framekit",
      };

  return [
    primary,
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "FrameKit", item: siteUrl },
        ...(page.slug === "/"
          ? []
          : [{ "@type": "ListItem", position: 2, name: page.title, item: pageUrl }]),
      ],
    },
  ];
}

export function serializeJsonLd(value: Record<string, unknown>[]): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
