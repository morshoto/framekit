import type { Metadata } from "next";

import { ContentPage } from "@/app/_views/ContentPage";
import { buildPageMetadata } from "@/lib/metadata";
import { readWikiPage } from "@/lib/wiki";

const localizedPaths = { en: "/docs/", ja: "/ja/docs/" };

export async function generateMetadata(): Promise<Metadata> {
  const page = await readWikiPage("ja", "docs", "index");
  return buildPageMetadata(page.frontmatter, localizedPaths);
}

export default function JapaneseDocsPage() {
  return (
    <ContentPage
      locale="ja"
      section="docs"
      fileName="index"
      nextHref="https://github.com/morshoto/framekit/blob/main/docs/getting-started.md"
      nextLabel="Getting Startedを開く"
    />
  );
}
