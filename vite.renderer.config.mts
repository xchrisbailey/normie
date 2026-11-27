import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// NORMIE_COMPILER_LOG=1 prints what the React Compiler compiled and skipped.
const logger = process.env.NORMIE_COMPILER_LOG
  ? {
      logEvent(filename: string | null, event: { kind: string; fnName?: string | null; reason?: string; detail?: { reason?: string } }) {
        const name = `${filename?.replace(/.*src\/renderer\//, '') ?? '?'} ${event.fnName ?? '(anonymous)'}`;
        if (event.kind === 'CompileSuccess') {
          process.stdout.write(`[compiler] ok   ${name}\n`);
        } else if (event.kind !== 'CompileSkip' || event.reason !== 'Not a component or hook') {
          process.stdout.write(`[compiler] ${event.kind} ${name} ${event.reason ?? event.detail?.reason ?? ''}\n`);
        }
      },
    }
  : undefined;

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), babel({ presets: [reactCompilerPreset(logger ? { logger } : {})] })],
  build: { outDir: '../../out/renderer', emptyOutDir: true, target: 'chrome140', modulePreload: false },
});
