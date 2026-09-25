import Link from "next/link";

import styles from "./SiteFooter.module.scss";

export type SiteFooterProps = {
  locale: "en" | "ja";
};

function localPath(locale: SiteFooterProps["locale"], path: string): string {
  return locale === "ja" ? `/ja${path === "/" ? "/" : path}` : path;
}

export function SiteFooter({ locale }: SiteFooterProps) {
  return (
    <footer className={styles.footer}>
      <div className={styles.lead}>
        <p>FRAMEKIT / OPEN SOURCE</p>
        <h2>{locale === "ja" ? "AIと編集者の間に、信頼できるbridgeを。" : "A trustworthy bridge between AI and the edit."}</h2>
      </div>
      <div className={styles.links}>
        <div>
          <h3>{locale === "ja" ? "探す" : "Explore"}</h3>
          <Link href={localPath(locale, "/use-cases/final-cut-pro-ai/")}>Use Cases</Link>
          <Link href={localPath(locale, "/learn/final-cut-pro-ai/")}>Learn</Link>
          <Link href={localPath(locale, "/docs/")}>Docs</Link>
        </div>
        <div>
          <h3>{locale === "ja" ? "プロジェクト" : "Project"}</h3>
          <a href="https://github.com/morshoto/framekit">GitHub</a>
          <a href="https://github.com/morshoto/framekit/blob/main/docs/COMPATIBILITY.md">Compatibility</a>
          <a href="https://github.com/morshoto/framekit/tree/main/docs/tests">Validation</a>
        </div>
      </div>
      <div className={styles.bottom}>
        <span>© {new Date().getFullYear()} FrameKit</span>
        <span>{locale === "ja" ? "動画編集者のためのagentic runtime" : "Agentic runtime for video editors"}</span>
      </div>
    </footer>
  );
}
