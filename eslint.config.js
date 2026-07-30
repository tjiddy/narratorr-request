import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// Flat config — mirrors Narratorr's enforced bar: no-explicit-any, type-imports,
// type-checked rules (return-await, no-floating-promises), complexity/size caps,
// and layering guards. Repo-local custom plugins remain a separate item.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '.scratch/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/drizzle/**',
      '**/coverage/**',
      '**/.reviews/**',
      // Static browser bootstrap assets — served as-is, not part of the typed
      // source graph (tsconfig doesn't include them, so type-checked parsing can't).
      '**/src/client/public/**',
      // One-shot operator scripts (plain CJS run inside the prod container) —
      // outside the typed source graph for the same reason.
      'scripts/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        // Type-checked parsing — prerequisite for `return-await` /
        // `no-floating-promises`. Config files are ignored above, so no
        // project-membership errors; tsconfig already covers src/** + scripts/**.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React client files
  {
    files: ['**/src/client/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Server code may log
  {
    files: ['**/src/server/**/*.ts', '**/src/db/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Layering guards — client must not import server or fastify.
  {
    files: ['**/src/client/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/server/**', '**/server/*'],
        paths: [{ name: 'fastify', message: 'fastify must not be imported from client code.' }],
      }],
    },
  },
  // Shared must not import core/server.
  {
    files: ['**/src/shared/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/core/**', '**/core/*', '**/server/**', '**/server/*', '@core/**', '@core/*', '@/**'],
      }],
    },
  },

  // services is below routes — it must never reach up into the route layer.
  // (narratorr also bans this for jobs/**; we have no jobs/ layer.)
  {
    files: ['**/src/server/services/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/routes/**', '**/routes/*'], message: 'services is below routes — do not import the route layer.' },
        ],
      }],
    },
  },

  // Shared rules
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      // Fire-and-forget async (notifier dispatch, poller) must be marked `void`
      // so an unhandled rejection is an explicit choice, not a silent drop.
      '@typescript-eslint/no-floating-promises': 'error',
      complexity: ['error', { max: 15 }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-useless-escape': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Declarative Drizzle catalog — a flat table of column definitions, not logic.
  {
    files: ['**/src/db/schema.ts'],
    rules: { 'max-lines': 'off' },
  },

  // Tests — relax noise. Test files legitimately run long and branch widely.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },
);
