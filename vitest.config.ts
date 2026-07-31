import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Two projects, split by file extension (the globs are disjoint — no file runs twice):
//   node   — server/shared/db plus pure client logic helpers (*.test.ts, no DOM).
//   client — React component/interaction tests (*.test.tsx) under jsdom.
// `extends: true` on each project is load-bearing: project entries are their own Vite configs
// and would not inherit the root `resolve.alias` (@ / @shared) without it.
// Coverage stays at the root `test` level — it is global in Vitest 4, not a per-project option.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/client'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/{server,shared,db,client}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/client/**/*.test.tsx'],
          setupFiles: ['src/client/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['src/server/index.ts'],
    },
  },
});
