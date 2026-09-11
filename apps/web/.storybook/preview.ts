import type { Preview } from "@storybook/nextjs-vite";

import "../app/globals.scss";

const preview: Preview = {
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: "error",
    },
    options: {
      storySort: {
        order: ["Marketing", "Navigation", "Content"],
      },
    },
  },
};

export default preview;
