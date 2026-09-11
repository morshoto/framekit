import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { WikiArticle } from "./WikiArticle";

const meta = {
  title: "Content/WikiArticle",
  component: WikiArticle,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Localized long-form content shell for use-case, Learn, Docs, and Blog pages.",
      },
    },
  },
  args: {
    locale: "en",
    eyebrow: "Learn",
    title: "How to Use AI with Final Cut Pro",
    description: "A practical introduction to observable, reviewable, and reversible AI-assisted editing.",
    keywords: ["Final Cut Pro AI", "AI video editing workflow"],
    body: "## Start with a bounded task\n\nInspect the available capability before requesting an edit.\n\n1. Read context.\n2. Review the proposal.\n3. Apply a supported operation.",
    nextHref: "/use-cases/final-cut-pro-ai/",
    nextLabel: "Explore FrameKit for Final Cut Pro",
  },
} satisfies Meta<typeof WikiArticle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LearnArticle: Story = {};

export const DocumentationIndex: Story = {
  args: {
    eyebrow: "Docs",
    title: "FrameKit Docs",
    description: "Install, connect, inspect, then go deeper.",
    keywords: [],
  },
};
