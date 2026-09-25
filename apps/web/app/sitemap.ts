import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/metadata";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    { path: "/", priority: 1, changeFrequency: "weekly" },
    { path: "/ja/", priority: 1, changeFrequency: "weekly" },
    { path: "/use-cases/final-cut-pro-ai/", priority: 0.9, changeFrequency: "monthly" },
    { path: "/ja/use-cases/final-cut-pro-ai/", priority: 0.9, changeFrequency: "monthly" },
    { path: "/learn/final-cut-pro-ai/", priority: 0.85, changeFrequency: "monthly" },
    { path: "/ja/learn/final-cut-pro-ai/", priority: 0.85, changeFrequency: "monthly" },
    { path: "/docs/", priority: 0.9, changeFrequency: "weekly" },
    { path: "/ja/docs/", priority: 0.9, changeFrequency: "weekly" },
    { path: "/blog/", priority: 0.7, changeFrequency: "weekly" },
    { path: "/ja/blog/", priority: 0.7, changeFrequency: "weekly" },
  ] as const;

  return routes.map(({ path, priority, changeFrequency }) => ({
    url: new URL(path, siteUrl).toString(),
    priority,
    changeFrequency,
  }));
}
