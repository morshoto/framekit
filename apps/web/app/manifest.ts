import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FrameKit",
    short_name: "FrameKit",
    description: "A capability-aware bridge between AI agents and Final Cut Pro.",
    start_url: "/",
    display: "standalone",
    background_color: "#050a12",
    theme_color: "#050a12",
    icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
