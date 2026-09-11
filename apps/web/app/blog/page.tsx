import type { Metadata } from "next";

import { ContentPage } from "@/app/_views/ContentPage";
import { buildPageMetadata } from "@/lib/metadata";
import { readWikiPage } from "@/lib/wiki";

const localizedPaths = { en: "/blog/", ja: "/ja/blog/" };

export async function generateMetadata(): Promise<Metadata> {
  const page = await readWikiPage("en", "blog", "index");
  return buildPageMetadata(page.frontmatter, localizedPaths);
}

export default function BlogPage() {
  return (
    <ContentPage
      locale="en"
      section="blog"
      fileName="index"
      nextHref="/learn/final-cut-pro-ai/"
      nextLabel="Start with Learn"
    />
  );
}
