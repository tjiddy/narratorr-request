// Setup for the jsdom `client` vitest project (see vitest.config.ts). Lives under src/ on
// purpose: tsconfig's include is ["src/**/*"], so a root-level setup file would sit outside the
// type program and jest-dom's Assertion augmentation would never reach `tsc --noEmit`.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL auto-registers cleanup only when a global `afterEach` exists. This repo runs with
// `globals` off (every test imports describe/it/expect explicitly), so register it by hand —
// enabling `globals: true` would change semantics for the node project too.
afterEach(cleanup);
