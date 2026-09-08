import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { siteUrl } from "@/lib/metadata";

import "./globals.scss";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "FrameKit",
  title: "FrameKit — AI meets Final Cut Pro",
  description: "A capability-aware bridge between AI agents and Final Cut Pro.",
  icons: { icon: "/favicon.svg" },
  category: "technology",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050a12",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
