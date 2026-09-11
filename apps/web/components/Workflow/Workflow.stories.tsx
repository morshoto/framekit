import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Workflow } from "./Workflow";

const meta = {
  title: "Marketing/Workflow",
  component: Workflow,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Four-step progression from timeline context to an explicitly supported Final Cut operation.",
      },
    },
  },
  args: {
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
} satisfies Meta<typeof Workflow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
