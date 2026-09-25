import Link from "next/link";

import styles from "./SiteHeader.module.scss";

export type SiteHeaderProps = {
  locale: "en" | "ja";
  variant?: "marketing" | "docs";
};

const labels = {
  en: {
    product: "Product",
    useCases: "Use Cases",
    learn: "Learn",
    docs: "Docs",
    language: "日本語",
    getStarted: "Get Started",
  },
  ja: {
    product: "Product",
    useCases: "Use Cases",
    learn: "Learn",
    docs: "Docs",
    language: "English",
    getStarted: "始める",
  },
} as const;

function localPath(locale: SiteHeaderProps["locale"], path: string): string {
  return locale === "ja" ? `/ja${path === "/" ? "/" : path}` : path;
}

export function SiteHeader({ locale, variant = "marketing" }: SiteHeaderProps) {
  const copy = labels[locale];
  const languageHref = locale === "en" ? "/ja/" : "/";

  return (
    <header className={`${styles.header} ${styles[variant]}`}>
      <div className={styles.inner}>
        <Link className={styles.brand} href={localPath(locale, "/")} aria-label="FrameKit home">
          <span className={styles.mark} aria-hidden="true">
            FK
          </span>
          <span>
            FrameKit
            {variant === "docs" ? <small>/ Docs</small> : null}
          </span>
        </Link>

        <nav className={styles.navigation} aria-label="Primary navigation">
          <Link href={localPath(locale, "/")}>{copy.product}</Link>
          <Link href={localPath(locale, "/use-cases/final-cut-pro-ai/")}>{copy.useCases}</Link>
          <Link href={localPath(locale, "/learn/final-cut-pro-ai/")}>{copy.learn}</Link>
          <Link href={localPath(locale, "/docs/")}>{copy.docs}</Link>
          <a href="https://github.com/morshoto/framekit">GitHub</a>
        </nav>

        <div className={styles.actions}>
          <Link className={styles.language} href={languageHref} hrefLang={locale === "en" ? "ja" : "en"}>
            {copy.language}
          </Link>
          <Link className={styles.cta} href={localPath(locale, "/docs/")}>
            {copy.getStarted}
          </Link>
        </div>
      </div>
    </header>
  );
}
