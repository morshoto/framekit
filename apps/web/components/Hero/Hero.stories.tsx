import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Hero } from "./Hero";

const meta = {
  title: "Marketing/Hero",
  component: Hero,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Creator-first hero that presents FrameKit as a bridge before introducing MCP terminology.",
      },
    },
  },
  args: {
    locale: "en",
    eyebrow: "Open-source AI video editing",
    title: "Edit Final Cut with AI.",
    description: "Tell your AI what you want changed. FrameKit connects it to your Final Cut workflow.",
    primaryAction: { href: "/use-cases/final-cut-pro-ai/", label: "Explore the workflow" },
    secondaryAction: { href: "/docs/", label: "Read the docs" },
  },
} satisfies Meta<typeof Hero>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {};

export const Japanese: Story = {
  args: {
    locale: "ja",
    eyebrow: "オープンソースのAI動画編集",
    title: "Final CutをAIで編集。",
    description: "AIに変更したい内容を伝えると、FrameKitがFinal Cutの編集ワークフローにつなぎます。",
    primaryAction: { href: "/ja/use-cases/final-cut-pro-ai/", label: "ワークフローを見る" },
    secondaryAction: { href: "/ja/docs/", label: "Docsを読む" },
  },
};
