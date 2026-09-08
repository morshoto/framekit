import Link from "next/link";

import styles from "./Hero.module.scss";

export type HeroAction = {
  href: string;
  label: string;
};

export type HeroProps = {
  locale: "en" | "ja";
  eyebrow: string;
  title: string;
  description: string;
  primaryAction: HeroAction;
  secondaryAction: HeroAction;
};

export function Hero({
  locale,
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
}: HeroProps) {
  const prompt = locale === "ja"
    ? "無音部分をカットして、このセクションのテンポを上げて。"
    : "Cut the pauses and tighten this section.";

  return (
    <section className={styles.hero}>
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.copy}>
        <p className={styles.eyebrow}>
          <span aria-hidden="true" />
          {eyebrow}
        </p>
        <h1>{title}</h1>
        <p className={styles.description}>{description}</p>
        <div className={styles.actions}>
          <Link className={styles.primary} href={primaryAction.href}>
            {primaryAction.label}
            <span aria-hidden="true">↗</span>
          </Link>
          <Link className={styles.secondary} href={secondaryAction.href}>
            {secondaryAction.label}
          </Link>
        </div>
        <p className={styles.proof}>
          <span aria-hidden="true">◆</span>
          {locale === "ja"
            ? "Open source · Capability-aware · Final Cutを置き換えない"
            : "Open source · Capability-aware · Keep Final Cut as your editor"}
        </p>
      </div>

      <div className={styles.demo} aria-label={locale === "ja" ? "FrameKitワークフローのデモ" : "FrameKit workflow demo"}>
        <div className={styles.windowBar}>
          <span />
          <span />
          <span />
          <p>FRAMEKIT / LIVE SESSION</p>
        </div>
        <div className={styles.prompt}>
          <p className={styles.label}>YOU</p>
          <blockquote>“{prompt}”</blockquote>
        </div>
        <div className={styles.route}>
          <div>
            <span>01</span>
            <strong>AI Agent</strong>
            <small>Codex · Claude Code</small>
          </div>
          <span className={styles.connector}>→</span>
          <div className={styles.active}>
            <span>02</span>
            <strong>FrameKit</strong>
            <small>Review · Capability check</small>
          </div>
          <span className={styles.connector}>→</span>
          <div>
            <span>03</span>
            <strong>Final Cut Pro</strong>
            <small>Your editor stays in control</small>
          </div>
        </div>
        <div className={styles.status}>
          <span className={styles.pulse} aria-hidden="true" />
          PREVIEW READY
          <code>0 mutations</code>
        </div>
      </div>
    </section>
  );
}
