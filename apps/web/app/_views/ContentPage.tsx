import { CapabilityGrid, SiteFooter, SiteHeader, WikiArticle } from "@/components";
import { buildJsonLd, serializeJsonLd } from "@/lib/metadata";
import { readCapabilities, readWikiPage, type Locale, type WikiSection } from "@/lib/wiki";

import styles from "./ContentPage.module.scss";

type ContentPageProps = {
  locale: Locale;
  section: Exclude<WikiSection, "product">;
  fileName: string;
  nextHref?: string;
  nextLabel?: string;
};

const docsGroups = {
  en: [
    { title: "Getting Started", description: "Installation and the shortest path to a verified first connection.", href: "https://github.com/morshoto/framekit/blob/main/docs/getting-started.md" },
    { title: "Final Cut Pro", description: "Workflow Extension setup, live connection, capability boundaries, and troubleshooting.", href: "https://github.com/morshoto/framekit/tree/main/docs/final-cut" },
    { title: "MCP Reference", description: "Tools, protocol, capabilities, errors, and client configuration.", href: "https://github.com/morshoto/framekit/tree/main/docs/mcp" },
    { title: "Architecture", description: "Runtime boundaries, adapters, backend selection, and system design.", href: "https://github.com/morshoto/framekit/tree/main/docs/architecture" },
    { title: "Validation", description: "Deterministic gates and headed-native evidence kept separate by tier.", href: "https://github.com/morshoto/framekit/tree/main/docs/tests" },
    { title: "Project", description: "Product requirements, design documents, and architecture decisions.", href: "https://github.com/morshoto/framekit/tree/main/docs" },
  ],
  ja: [
    { title: "Getting Started", description: "Installから検証可能な最初の接続まで、最短経路を案内します。", href: "https://github.com/morshoto/framekit/blob/main/docs/getting-started.md" },
    { title: "Final Cut Pro", description: "Workflow Extension、live接続、capability境界、troubleshooting。", href: "https://github.com/morshoto/framekit/tree/main/docs/final-cut" },
    { title: "MCP Reference", description: "Tool、protocol、capability、error、client設定。", href: "https://github.com/morshoto/framekit/tree/main/docs/mcp" },
    { title: "Architecture", description: "Runtime boundary、adapter、backend選択、system design。", href: "https://github.com/morshoto/framekit/tree/main/docs/architecture" },
    { title: "Validation", description: "Deterministic gateとheaded-native evidenceをtierごとに確認できます。", href: "https://github.com/morshoto/framekit/tree/main/docs/tests" },
    { title: "Project", description: "Product requirements、design document、architecture decision。", href: "https://github.com/morshoto/framekit/tree/main/docs" },
  ],
} as const;

export async function ContentPage({ locale, section, fileName, nextHref, nextLabel }: ContentPageProps) {
  const [page, capabilities] = await Promise.all([
    readWikiPage(locale, section, fileName),
    section === "use-cases" ? readCapabilities(locale) : Promise.resolve([]),
  ]);
  const meta = page.frontmatter;

  return (
    <>
      <SiteHeader locale={locale} variant={section === "docs" ? "docs" : "marketing"} />
      <main>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildJsonLd(meta)) }}
        />
        <WikiArticle
          locale={locale}
          eyebrow={meta.eyebrow ?? section}
          title={meta.title}
          description={meta.description}
          body={page.body}
          keywords={meta.keywords}
          nextHref={nextHref}
          nextLabel={nextLabel}
        />

        {section === "docs" ? (
          <section className={styles.docsDirectory} aria-labelledby="docs-directory-title">
            <header>
              <p>FRAMEKIT KNOWLEDGE BASE</p>
              <h2 id="docs-directory-title">{locale === "ja" ? "目的に合う深さから読む。" : "Enter at the depth you need."}</h2>
            </header>
            <div>
              {docsGroups[locale].map((group, index) => (
                <a href={group.href} key={group.title}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <h3>{group.title}</h3>
                  <p>{group.description}</p>
                  <strong aria-hidden="true">↗</strong>
                </a>
              ))}
            </div>
          </section>
        ) : null}

        {section === "use-cases" ? (
          <CapabilityGrid
            locale={locale}
            eyebrow={locale === "ja" ? "現在の対応状況" : "Current compatibility"}
            title={locale === "ja" ? "実行前に、対応範囲を確認。" : "Check the boundary before you run."}
            description={locale === "ja"
              ? "Marketing pageと実装の差をなくすため、各項目をrepositoryのcanonical documentにつなぎます。"
              : "Each item links back to the repository's canonical documentation so the product page cannot outrun the implementation."}
            capabilities={capabilities}
          />
        ) : null}
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}
