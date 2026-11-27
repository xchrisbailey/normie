import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [...cloudflare.ignorePatterns, 'out/**', 'dist/**', 'bench/fixture/**'],
  overrides: [
    {
      // The log (src/core/log.ts), and the command-line scripts, whose console output is what they're for.
      files: ['src/core/log.ts', 'scripts/**', 'bench/**'],
      rules: { 'no-console': 'off' },
    },
  ],
});
