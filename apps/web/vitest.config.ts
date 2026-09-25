import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["components/**/*.test.tsx", "lib/**/*.test.ts"],
    css: true,
  },
});
