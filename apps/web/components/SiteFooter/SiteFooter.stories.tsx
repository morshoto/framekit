import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { SiteFooter } from "./SiteFooter";

const meta = {
  title: "Navigation/SiteFooter",
  component: SiteFooter,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Localized footer that keeps product discovery, technical evidence, and GitHub connected.",
      },
    },
  },
  args: { locale: "en" },
  argTypes: {
    locale: { control: "inline-radio", options: ["en", "ja"] },
  },
} satisfies Meta<typeof SiteFooter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {};

export const Japanese: Story = {
  args: { locale: "ja" },
};
