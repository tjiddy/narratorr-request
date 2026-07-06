import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Single node project for MVP — unit tests live in server/shared/db plus pure
// client logic helpers (*.test.ts under src/client; no DOM needed). A jsdom client
// project can be added later for React component tests (*.test.tsx).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/{server,shared,db,client}/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      // Components (.tsx) have no jsdom project yet; client pure-logic .ts files ARE covered.
      exclude: ['src/server/index.ts', 'src/client/**/*.tsx'],
    },
  },
});
