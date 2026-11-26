import { defineConfig } from 'vitest/config';

// Live contract tests against real Accounts. Run by hand only: npm run test:live
export default defineConfig({ test: { include: ['tests/live/**/*.live.test.ts'], environment: 'node', testTimeout: 120_000, fileParallelism: false } });
