import Link from "next/link";
import ReactMarkdown from "react-markdown";

import { CapabilityGrid, Hero, SiteFooter, SiteHeader, Workflow } from "@/components";
import { buildJsonLd, serializeJsonLd } from "@/lib/metadata";
import { readCapabilities, readWikiPage, type Locale } from "@/lib/wiki";

import styles from "./LandingPage.module.scss";

const content = {
  en: {
    signals: ["FINAL CUT STAYS YOUR EDITOR", "REVIEW BEFORE EXECUTE", "CAPABILITY-AWARE", "OPEN SOURCE"],
    workflow: {
      eyebrow: "How it works",
      title: "From intention to a reviewed edit.",
      description: "FrameKit keeps the target, capability boundary, and proposed change visible before execution.",
      steps: [
        { label: "Understand", title: "Read the context", description: "Inspect what the active backend can actually observe." },
        { label: "Describe", title: "State your intent", description: "Tell the agent the outcome you want in plain language." },
        { label: "Review", title: "Check the proposal", description: "Confirm the target, warnings, and supported operation." },
        { label: "Apply", title: "Execute deliberately", description: "Run only after capability and revision checks pass." },
      ],
    },
    paths: {
      eyebrow: "Built around your workflow",
      title: "Start with the outcome, not the protocol.",
      description: "Explore FrameKit from the perspective that matches why you came here.",
      cards: [
        { number: "01", label: "Use case", title: "Bring AI into Final Cut Pro", body: "See a creator-friendly, review-first editing workflow.", href: "/use-cases/final-cut-pro-ai/" },
        { number: "02", label: "Learn", title: "Understand AI-assisted editing", body: "Learn the approaches, limits, and questions to ask.", href: "/learn/final-cut-pro-ai/" },
        { number: "03", label: "Docs", title: "Install and go deeper", body: "Move from first connection to runtime and MCP reference.", href: "/docs/" },
      ],
    },
    capability: {
      eyebrow: "Honest by design",
      title: "Know what works before you edit.",
      description: "Capabilities differ between fixture, document, session, and live paths. Every public claim links to canonical evidence.",
    },
    identity: {
      eyebrow: "Under the hood",
      title: "Value first. Implementation when you need it.",
      quote: "FrameKit is an open-source agentic video editing runtime built on MCP.",
      note: "Product pages call it a bridge. Docs explain the protocol, runtime boundaries, adapters, and verification model in full.",
    },
    cta: {
      eyebrow: "Ready to explore?",
      title: "Keep your editor. Add an agent-aware layer.",
      primary: "Get started",
      secondary: "View on GitHub",
    },
  },
  ja: {
    signals: ["FINAL CUTを使い続ける", "実行前にレビュー", "CAPABILITY-AWARE", "OPEN SOURCE"],
    workflow: {
      eyebrow: "仕組み",
      title: "意図から、レビュー済みの編集へ。",
      description: "FrameKitは実行前に、対象、capabilityの境界、提案された変更を見える状態に保ちます。",
      steps: [
        { label: "理解", title: "コンテキストを読む", description: "現在のbackendが実際に観測できる内容を確認します。" },
        { label: "依頼", title: "意図を伝える", description: "実現したい編集結果を自然な言葉でAIに伝えます。" },
        { label: "確認", title: "提案をレビュー", description: "対象、警告、対応する操作を実行前に確認します。" },
        { label: "適用", title: "意図的に実行", description: "Capabilityとrevisionの確認に通った操作だけを実行します。" },
      ],
    },
    paths: {
      eyebrow: "ワークフローから探す",
      title: "Protocolではなく、目的から始める。",
      description: "FrameKitを知った理由に合う入口から、必要な深さまで進めます。",
      cards: [
        { number: "01", label: "Use case", title: "Final CutにAIを取り入れる", body: "クリエイター向けのreview-firstな編集フローを確認します。", href: "/ja/use-cases/final-cut-pro-ai/" },
        { number: "02", label: "Learn", title: "AI動画編集を理解する", body: "アプローチ、制約、導入前に確認すべきことを学びます。", href: "/ja/learn/final-cut-pro-ai/" },
        { number: "03", label: "Docs", title: "Installして深掘りする", body: "最初の接続からruntimeとMCP referenceへ進みます。", href: "/ja/docs/" },
      ],
    },
    capability: {
      eyebrow: "できることを明確に",
      title: "編集前にcapabilityを確認。",
      description: "Fixture、document、session、liveでは利用できる機能が異なります。すべての公開claimをcanonicalな根拠につなぎます。",
    },
    identity: {
      eyebrow: "技術的な仕組み",
      title: "まず価値を理解し、必要なときに実装へ。",
      quote: "FrameKitは、MCPを基盤とするオープンソースのagentic video editing runtimeです。",
      note: "Productではbridgeとして説明し、Docsではprotocol、runtime boundary、adapter、verification modelを詳しく扱います。",
    },
    cta: {
      eyebrow: "試してみますか？",
      title: "編集ソフトはそのまま。AI agentとつながるlayerを追加。",
      primary: "始める",
      secondary: "GitHubを見る",
    },
  },
} as const;

export async function LandingPage({ locale }: { locale: Locale }) {
  const [page, capabilities] = await Promise.all([
    readWikiPage(locale, "product", "home"),
    readCapabilities(locale),
  ]);
  const copy = content[locale];
  const meta = page.frontmatter;

  return (
    <>
      <SiteHeader locale={locale} />
      <main>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildJsonLd(meta)) }}
        />
        <Hero
          locale={locale}
          eyebrow={meta.eyebrow ?? "FrameKit"}
          title={meta.title}
          description={meta.description}
          primaryAction={{ href: meta.primaryHref ?? "/docs/", label: meta.primaryLabel ?? "Get started" }}
          secondaryAction={{ href: meta.secondaryHref ?? "/docs/", label: meta.secondaryLabel ?? "Docs" }}
        />

        <div className={styles.signals} aria-label={locale === "ja" ? "FrameKitの原則" : "FrameKit principles"}>
          {copy.signals.map((signal) => <span key={signal}>{signal}</span>)}
        </div>

        <Workflow {...copy.workflow} />

        <section className={styles.paths} aria-labelledby="paths-title">
          <div className={styles.sectionHeading}>
            <p>{copy.paths.eyebrow}</p>
            <h2 id="paths-title">{copy.paths.title}</h2>
            <span>{copy.paths.description}</span>
          </div>
          <div className={styles.pathGrid}>
            {copy.paths.cards.map((card) => (
              <Link href={card.href} key={card.number}>
                <div><span>{card.number}</span><small>{card.label}</small></div>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <strong aria-hidden="true">↗</strong>
              </Link>
            ))}
          </div>
        </section>

        <CapabilityGrid
          locale={locale}
          eyebrow={copy.capability.eyebrow}
          title={copy.capability.title}
          description={copy.capability.description}
          capabilities={capabilities}
        />

        <section className={styles.identity}>
          <div>
            <p>{copy.identity.eyebrow}</p>
            <h2>{copy.identity.title}</h2>
          </div>
          <div className={styles.identityBody}>
            <blockquote>{copy.identity.quote}</blockquote>
            <p>{copy.identity.note}</p>
            <div className={styles.sourceCopy}><ReactMarkdown>{page.body}</ReactMarkdown></div>
          </div>
        </section>

        <section className={styles.cta}>
          <p>{copy.cta.eyebrow}</p>
          <h2>{copy.cta.title}</h2>
          <div>
            <Link href={locale === "ja" ? "/ja/docs/" : "/docs/"}>{copy.cta.primary}<span aria-hidden="true">→</span></Link>
            <a href="https://github.com/morshoto/framekit">{copy.cta.secondary}</a>
          </div>
        </section>
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}
