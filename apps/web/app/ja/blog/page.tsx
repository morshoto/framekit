import type { Metadata } from "next";

import { ContentPage } from "@/app/_views/ContentPage";
import { buildPageMetadata } from "@/lib/metadata";
import { readWikiPage } from "@/lib/wiki";

const localizedPaths = { en: "/blog/", ja: "/ja/blog/" };

export async function generateMetadata(): Promise<Metadata> {
  const page = await readWikiPage("ja", "blog", "index");
  return buildPageMetadata(page.frontmatter, localizedPaths);
}

export default function JapaneseBlogPage() {
  return (
    <ContentPage
      locale="ja"
      section="blog"
      fileName="index"
      nextHref="/ja/learn/final-cut-pro-ai/"
      nextLabel="Learnから始める"
    />
  );
}
