/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Mirrors apps/web/nginx.conf so development and production share one origin model. See
    // that file for why the app is not split across two origins.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      // Kept in step with apps/web/nginx.conf, which says the same. Both were missing this, so
      // a webhook never reached the API in development either.
      '/webhooks': 'http://localhost:3000',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      // Every source file, not only the ones a test happened to import. Without `all`, a
      // component with no test at all is absent from the report rather than counted as zero —
      // which is the one thing a coverage gate exists to notice.
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // The entry point: it mounts the app and has nothing to assert about.
        'src/main.tsx',
        'src/**/*.test.{ts,tsx}',
        'src/test-support.tsx',
        'src/vite-env.d.ts',
      ],
      reporter: ['text-summary', 'lcov'],
      /**
       * Set just under where the suite already stands, so this is a ratchet against regression
       * rather than a number to chase. Measured before choosing: 90.17% lines and statements,
       * 85.85% branches, 89.6% functions.
       *
       * Functions is 88 rather than the API's 90 because the suite is genuinely at 89.6 — a gate
       * that fails on the day it is introduced teaches people to pass `--no-coverage`.
       */
      thresholds: {
        lines: 90,
        statements: 90,
        branches: 85,
        functions: 88,
      },
    },
  },
});
