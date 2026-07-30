// Setup for the jsdom `client` vitest project (see vitest.config.ts). Lives under src/ on
// purpose: tsconfig's include is ["src/**/*"], so a root-level setup file would sit outside the
// type program and jest-dom's Assertion augmentation would never reach `tsc --noEmit`.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL auto-registers cleanup only when a global `afterEach` exists. This repo runs with
// `globals` off (every test imports describe/it/expect explicitly), so register it by hand —
// enabling `globals: true` would change semantics for the node project too.
afterEach(cleanup);

// jsdom implements no media queries at all, and `Layout` mounts `useTheme`, which reads
// `prefers-color-scheme` — so any test rendering the signed-in shell throws without a
// `matchMedia`. Stub it here once instead of per-file. A `beforeEach` (not a module-scope
// stub) on purpose: nearly every jsdom test file runs `vi.unstubAllGlobals()` in its own
// afterEach, which would strip a one-time stub after the file's first test. Setup-file hooks
// run before test-file hooks, so a file needing a different shape can still override.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })),
  );
});
