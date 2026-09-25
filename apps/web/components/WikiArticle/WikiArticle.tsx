import Link from "next/link";
import ReactMarkdown from "react-markdown";

import styles from "./WikiArticle.module.scss";

export type WikiArticleProps = {
  locale: "en" | "ja";
  eyebrow: string;
  title: string;
  description: string;
  body: string;
  keywords?: string[];
  nextHref?: string;
  nextLabel?: string;
};

export function WikiArticle({
  locale,
  eyebrow,
  title,
  description,
  body,
  keywords = [],
  nextHref,
  nextLabel,
}: WikiArticleProps) {
  return (
    <article className={styles.article}>
      <header>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.description}>{description}</p>
        {keywords.length > 0 ? (
          <ul className={styles.keywords} aria-label={locale === "ja" ? "トピック" : "Topics"}>
            {keywords.map((keyword) => <li key={keyword}>{keyword}</li>)}
          </ul>
        ) : null}
      </header>

      <div className={styles.body}>
        <ReactMarkdown>{body}</ReactMarkdown>
      </div>

      {nextHref && nextLabel ? (
        <aside className={styles.next}>
          <span>{locale === "ja" ? "次に読む" : "Continue exploring"}</span>
          <Link href={nextHref}>{nextLabel}<span aria-hidden="true">→</span></Link>
        </aside>
      ) : null}
    </article>
  );
}
