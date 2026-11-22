import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['src/**/*.test.tsx', 'src/**/*.spec.ts'] } });
