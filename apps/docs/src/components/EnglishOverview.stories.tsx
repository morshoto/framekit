import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { EnglishOverview } from "./EnglishOverview";
const meta = {
  component: EnglishOverview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EnglishOverview>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
