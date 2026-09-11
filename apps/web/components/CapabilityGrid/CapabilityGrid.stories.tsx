import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { CapabilityGrid } from "./CapabilityGrid";

const meta = {
  title: "Marketing/CapabilityGrid",
  component: CapabilityGrid,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Evidence-linked status cards that keep available, experimental, and planned behavior distinct.",
      },
    },
  },
  args: {
    locale: "en",
    eyebrow: "Honest by design",
    title: "Know what works before you edit.",
    description: "Capabilities differ by backend. Each claim links to its canonical evidence.",
    capabilities: [
      {
        id: "context",
        status: "available",
        source: "docs/COMPATIBILITY.md",
        title: "Read live editing context",
        description: "Inspect active project metadata, playhead, and selected range through the bundled bridge.",
      },
      {
        id: "native",
        status: "experimental",
        source: "docs/final-cut/installation.md",
        title: "Run guarded native operations",
        description: "Explicit opt-in and capability preflight keep native UI operations bounded.",
      },
      {
        id: "canonical",
        status: "coming-soon",
        source: "docs/COMPATIBILITY.md",
        title: "Canonical live timeline editing",
        description: "The bundled Workflow Extension does not advertise this capability today.",
      },
    ],
  },
} satisfies Meta<typeof CapabilityGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Japanese: Story = {
  args: {
    locale: "ja",
    eyebrow: "できることを明確に",
    title: "編集前にcapabilityを確認。",
    description: "Backendごとに利用できる機能は異なります。各claimはcanonicalな根拠につながります。",
  },
};
