import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { SiteHeader } from "./SiteHeader";

const meta = {
  title: "Navigation/SiteHeader",
  component: SiteHeader,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Locale-aware marketing and documentation navigation for the FrameKit site.",
      },
    },
  },
  args: {
    locale: "en",
    variant: "marketing",
  },
  argTypes: {
    locale: { control: "inline-radio", options: ["en", "ja"] },
    variant: { control: "inline-radio", options: ["marketing", "docs"] },
  },
} satisfies Meta<typeof SiteHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Marketing: Story = {};

export const Documentation: Story = {
  args: { variant: "docs" },
};

export const Japanese: Story = {
  args: { locale: "ja" },
};
