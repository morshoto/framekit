import type { Metadata } from "next";

import { ContentPage } from "@/app/_views/ContentPage";
import { buildPageMetadata } from "@/lib/metadata";
import { readWikiPage } from "@/lib/wiki";

const localizedPaths = {
  en: "/use-cases/final-cut-pro-ai/",
  ja: "/ja/use-cases/final-cut-pro-ai/",
};

export async function generateMetadata(): Promise<Metadata> {
  const page = await readWikiPage("en", "use-cases", "final-cut-pro-ai");
  return buildPageMetadata(page.frontmatter, localizedPaths);
}

export default function FinalCutProAiUseCasePage() {
  return (
    <ContentPage
      locale="en"
      section="use-cases"
      fileName="final-cut-pro-ai"
      nextHref="/docs/"
      nextLabel="Install FrameKit"
    />
  );
}
