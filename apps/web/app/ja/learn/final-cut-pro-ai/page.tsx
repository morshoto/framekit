import type { Metadata } from "next";

import { ContentPage } from "@/app/_views/ContentPage";
import { buildPageMetadata } from "@/lib/metadata";
import { readWikiPage } from "@/lib/wiki";

const localizedPaths = {
  en: "/learn/final-cut-pro-ai/",
  ja: "/ja/learn/final-cut-pro-ai/",
};

export async function generateMetadata(): Promise<Metadata> {
  const page = await readWikiPage("ja", "learn", "final-cut-pro-ai");
  return buildPageMetadata(page.frontmatter, localizedPaths);
}

export default function JapaneseFinalCutProAiLearnPage() {
  return (
    <ContentPage
      locale="ja"
      section="learn"
      fileName="final-cut-pro-ai"
      nextHref="/ja/use-cases/final-cut-pro-ai/"
      nextLabel="Final Cut向けFrameKitを見る"
    />
  );
}
