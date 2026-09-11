import type { Metadata } from "next";

import { LandingPage } from "@/app/_views/LandingPage";
import { buildPageMetadata } from "@/lib/metadata";
import { readWikiPage } from "@/lib/wiki";

export async function generateMetadata(): Promise<Metadata> {
  const page = await readWikiPage("en", "product", "home");
  return buildPageMetadata(page.frontmatter, { en: "/", ja: "/ja/" });
}

export default function HomePage() {
  return <LandingPage locale="en" />;
}
