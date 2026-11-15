import Link from "next/link";
import { DocsLayout } from "./DocsLayout";
import { getNavigationGroups } from "../lib/docs/source";
import { GitHubCommunity } from "./GitHubCommunity";
import { WorkflowDemo } from "./WorkflowDemo";
import styles from "./EnglishOverview.module.scss";

export function EnglishOverview() {
  return (
    <DocsLayout
      landing
      customHeading
      locale="en"
      title="Video editing, in your own words."
      groups={getNavigationGroups("en")}
      headings={[]}
    >
      <div className={styles.overview}>
        <section className={styles["hero"]} aria-labelledby="hero-title">
          <a
            className={styles["announcement"]}
            href="https://github.com/morshoto/framekit"
          >
            <strong>Open source</strong> Built for your AI workflow{" "}
            <span aria-hidden="true">↗</span>
          </a>
          <h1 id="hero-title">
            Video editing, <br />
            <span>in your own words.</span>
          </h1>
          <p className={styles["hero-description"]}>
            Bring your video workflow into Codex. <br />
            Inspect projects, preview changes, and work with your media through
            Framekit.
          </p>
          <div className={styles["hero-actions"]}>
            <Link
              className={styles["button"] + " " + styles["primary"]}
              href="/en/docs/installation/"
            >
              Get started <span aria-hidden="true">↗</span>
            </Link>
            <a
              className={styles["button"] + " " + styles["secondary"]}
              href="https://github.com/morshoto/framekit"
            >
              View on GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className={styles["hero-note"]}>
            <span aria-hidden="true"></span>Start with a connection check.
            Choose your editing workflow.
          </p>
        </section>
        <WorkflowDemo />
        <div className={styles["ecosystem"]} aria-label="Framekit ecosystem">
          <span className={styles["label"]}>A workflow built around</span>
          <strong>Codex</strong>
          <span className={styles["separator"]} aria-hidden="true"></span>
          <strong>Model Context Protocol</strong>
          <span className={styles["separator"]} aria-hidden="true"></span>
          <strong>Your media</strong>
          <span className={styles["separator"]} aria-hidden="true"></span>
          <strong>Final Cut Pro</strong>
        </div>
        <section
          className={styles["features"]}
          aria-labelledby="features-title"
        >
          <div className={styles["section-intro"]}>
            <h2 id="features-title">Less friction. More making.</h2>
            <p>
              A clear next step, from your first connection to your next edit.
            </p>
          </div>
          <div className={styles["feature-grid"]}>
            <Link className={styles["feature"]} href="/en/docs/quick-start/">
              <span className={styles["feature-icon"]} aria-hidden="true">
                ⌁
              </span>
              <h3>Start with a conversation</h3>
              <p>
                Ask Codex to check your connection and explain which operations
                your setup supports.
              </p>
              <span className={styles["feature-link"]}>
                Try your first prompt →
              </span>
            </Link>
            <Link
              className={styles["feature"]}
              href="/en/docs/headless-editing/"
            >
              <span className={styles["feature-icon"]} aria-hidden="true">
                ▤
              </span>
              <h3>Your media. Your project.</h3>
              <p>
                Create a Framekit project and work with your own media without
                opening Final Cut Pro.
              </p>
              <span className={styles["feature-link"]}>
                Explore headless editing →
              </span>
            </Link>
            <Link
              className={styles["feature"]}
              href="/en/docs/revisions-and-safety/"
            >
              <span className={styles["feature-icon"]} aria-hidden="true">
                ◇
              </span>
              <h3>Preview before you change</h3>
              <p>
                Inspect the current revision, preview your edit, and verify the
                result after execution.
              </p>
              <span className={styles["feature-link"]}>
                Understand the workflow →
              </span>
            </Link>
          </div>
        </section>
        <section className={styles["paths"]} aria-labelledby="paths-title">
          <h2 id="paths-title">Make it fit your workflow.</h2>
          <div className={styles["path-grid"]}>
            <article className={styles["path"]}>
              <span className={styles["path-number"]} aria-hidden="true">
                ↳
              </span>
              <div>
                <h3>Edit without Final Cut Pro</h3>
                <p>
                  Start with the plugin and your media. Configure a rendering
                  provider when you’re ready to produce output.
                </p>
                <Link href="/en/docs/headless-editing/">
                  Work with a Framekit project →
                </Link>
              </div>
            </article>
            <article className={styles["path"]}>
              <span className={styles["path-number"]} aria-hidden="true">
                ↳
              </span>
              <div>
                <h3>Connect to Final Cut Pro</h3>
                <p>
                  Use the matching Workflow Extension on macOS to inspect a live
                  connection and its available capabilities.
                </p>
                <Link href="/en/docs/final-cut-pro/">
                  Set up the integration →
                </Link>
              </div>
            </article>
          </div>
          <p className={styles["safety"]}>
            A ready Final Cut connection doesn’t mean every edit is available.
            Check the reported capabilities before editing.{" "}
            <Link href="/en/docs/revisions-and-safety/">
              Learn more about revisions and safety.
            </Link>
          </p>
        </section>

        <GitHubCommunity />
        <section
          className={styles["contribute"]}
          aria-labelledby="contribute-title"
        >
          <div>
            <h2 id="contribute-title">Build something with Framekit.</h2>
            <p>
              Explore the code, set up a checkout, and develop with the
              deterministic test editor.
            </p>
          </div>
          <Link href="/en/docs/development/">
            Contributor guide <span aria-hidden="true">↗</span>
          </Link>
        </section>
        <footer>
          <span>Framekit · Open source video editing tools</span>
          <a href="https://github.com/morshoto/framekit">GitHub ↗</a>
        </footer>
      </div>
    </DocsLayout>
  );
}
