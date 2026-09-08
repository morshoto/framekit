import styles from "./CapabilityGrid.module.scss";

export type CapabilityStatus = "available" | "experimental" | "coming-soon" | "unavailable";

export type CapabilityCard = {
  id: string;
  status: CapabilityStatus;
  source: string;
  title: string;
  description: string;
};

export type CapabilityGridProps = {
  locale: "en" | "ja";
  eyebrow: string;
  title: string;
  description: string;
  capabilities: CapabilityCard[];
};

const statusLabels = {
  en: {
    available: "Available now",
    experimental: "Experimental",
    "coming-soon": "Coming soon",
    unavailable: "Unavailable",
  },
  ja: {
    available: "現在利用可能",
    experimental: "Experimental",
    "coming-soon": "Coming soon",
    unavailable: "利用不可",
  },
} as const;

export function CapabilityGrid({
  locale,
  eyebrow,
  title,
  description,
  capabilities,
}: CapabilityGridProps) {
  const sourceLabel = locale === "ja" ? "根拠を見る" : "View evidence";

  return (
    <section className={styles.section} aria-labelledby="capability-title">
      <div className={styles.header}>
        <div>
          <p>{eyebrow}</p>
          <h2 id="capability-title">{title}</h2>
        </div>
        <span>{description}</span>
      </div>

      <div className={styles.grid}>
        {capabilities.map((capability) => (
          <article key={capability.id} data-status={capability.status}>
            <div className={styles.status}>
              <span aria-hidden="true" />
              {statusLabels[locale][capability.status]}
            </div>
            <h3>{capability.title}</h3>
            <p>{capability.description}</p>
            <a href={`https://github.com/morshoto/framekit/blob/main/${capability.source}`}>
              {sourceLabel}
              <span aria-hidden="true">↗</span>
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
