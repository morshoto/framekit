import styles from "./Workflow.module.scss";

export type WorkflowStep = {
  label: string;
  title: string;
  description: string;
};

export type WorkflowProps = {
  eyebrow: string;
  title: string;
  description: string;
  steps: readonly WorkflowStep[];
};

export function Workflow({ eyebrow, title, description, steps }: WorkflowProps) {
  return (
    <section className={styles.section} aria-labelledby="workflow-title">
      <div className={styles.heading}>
        <p>{eyebrow}</p>
        <h2 id="workflow-title">{title}</h2>
        <span>{description}</span>
      </div>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={step.label}>
            <div className={styles.number}>{String(index + 1).padStart(2, "0")}</div>
            <p>{step.label}</p>
            <h3>{step.title}</h3>
            <span>{step.description}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
