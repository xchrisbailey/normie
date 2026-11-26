import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Live contract tests (tests/live) run only by hand: npm run test:live
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], exclude: ['tests/live/**', 'node_modules/**'], environment: 'node' },
});
