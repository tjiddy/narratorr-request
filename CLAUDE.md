# CLAUDE.md — narratorr-requests

Operating notes for working in this codebase. The user-facing pitch + run instructions are in
[`README.md`](README.md); this file is the conventions/gotchas a contributor needs to not break
things.

## What it is

An Overseerr-style audiobook request app — a **contract-first plug-in sidecar** to **narratorr**
(Sonarr/Radarr for audiobooks). Users sign in, search/request books; an admin approves; approved
requests hand off to narratorr's `search → download → import` pipeline. It talks to narratorr
**only** over narratorr's public `/api/v1` (API key), with no other coupling.

## Stack

Fastify 5 + `fastify-type-provider-zod` · React 19 + React Router 7 + TanStack Query 5 · Drizzle +
libSQL (SQLite) · Zod everywhere · TypeScript (strict) · ESM · tsup (server bundle) + Vite (client)
· **pnpm** · **Node ≥ 24.10**. `"type": "module"`.

## Layout

- `src/server` — Fastify app, routes, services, plugins, the narratorr client, the MSW mock.
- `src/client` — React SPA (the browser only ever calls **our** `/api/*`).
- `src/shared/schemas` — Zod schemas shared client/server. `v1/` + `book.ts` = the **vendored
  narratorr contract** (see below); `request.ts`/`user.ts`/`connectors.ts` = our own domain.
- `src/db` — Drizzle schema + migration runner. `drizzle/` = generated migrations.

## Commands

| | |
|---|---|
| `pnpm dev` | server :3000 + client :5173 (Vite proxies `/api` → server) |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | `tsc --noEmit` / eslint / `vitest run` |
| `pnpm verify` | **lint && test && typecheck && build** — the gate; run before tagging |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit generate (interactive) / apply migrations |
| `pnpm build` / `pnpm start` | build client+server / run `dist/server` |

## Conventions & gotchas (read before editing)

- **ESM import extensions.** Relative imports use `.js` (`./foo.js`), even from `.ts` — Node ESM
  needs the runtime extension. `verbatimModuleSyntax` is on, so use `import type` for type-only
  imports. Path aliases: `@shared/*`, `@/*` (client).
- **TS strictness is load-bearing.** `exactOptionalPropertyTypes` → never assign `: undefined`;
  spread conditionally (`...(x !== undefined && { x })`). `noUncheckedIndexedAccess`,
  `noUnusedLocals/Parameters` are on too. Don't paper over with `any`/`as`.
- **The vendored contract is consumer-lenient, on purpose.** `src/shared/schemas/v1/{common,
  metadata,books,refs}.ts` + `src/shared/schemas/book.ts` mirror narratorr's own
  `src/shared/schemas/v1/` + `book.ts` layout (so it lifts cleanly into `@narratorr/api-contract`
  later). These schemas are **non-`.strict()`** and lenient — they assert only what we consume and
  tolerate provider drift on unused fields. **Do not add `.strict()`** here. A response that fails
  the schema becomes a `502 CONTRACT_MISMATCH` (`narratorr-client.ts`), so keep the schema as
  loose as the contract allows. `src/server/mocks/narratorr-v1.ts` is a **test fixture only** —
  there is no mock runtime mode.
- **Server-to-server only.** The narratorr API key is a secret used by `NarratorrClient` on the
  backend; it NEVER reaches the browser. The browser talks only to our `/api/*`. We **poll**
  narratorr (`GET /books/:id`) — no SSE (the key can't reach it).
- **Auth ≠ authz.** Authentication is pluggable (`AUTH_BYPASS` dev shortcut · local email+scrypt ·
  N generic OIDC providers); authorization is the in-app **approval queue** (`pending`/`active`/
  `rejected`). Identity is a generic `(authProvider, authSubject)` pair — **no account linking**.
  First user in becomes admin+active unless `BOOTSTRAP_ADMIN` pins one. `AUTH_BYPASS` makes every
  request the dev admin and refuses to run in prod, and refuses a non-loopback bind unless `ALLOW_INSECURE_AUTH_BYPASS` is set (see `config.ts`).
- **Connector config lives in the DB, not env.** The narratorr URL/key and notification channels
  (ntfy/email/webhook) are set in the admin **Settings** page and stored encrypted (`SecretCodec`,
  key derived from `SESSION_SECRET` or `SETTINGS_KEY`). The env surface is deliberately just
  auth + secrets — see `src/server/config.ts` for the authoritative list (`SESSION_SECRET`
  required in prod, `LOCAL_AUTH` default-on, `OIDC_PROVIDERS` + `OIDC_<ID>_*`, `BOOTSTRAP_ADMIN`,
  `TRUSTED_PROXIES`, `BIND_HOST`, …). The default request quota (limit + day/week/month window)
  is admin-editable in Settings and stored in `app_settings`, not env.
- **Request lifecycle:** `pending → approved → acquiring → available`, or `denied`/`failed`.
  `RequestService.handoff()` calls `addBook(asin)`; a `409` with `existingId` resolves to the
  existing book (idempotent by ASIN). The status poller drives `acquiring → available`;
  `mapBookStatus` collapses narratorr's `BookStatus` (`imported` → `available`). Notifications are
  **fire-and-forget** — the dispatcher never throws into the request path.
- **DB gotchas.** Migrations in `drizzle/` apply on boot (and via `pnpm db:migrate`). After a
  `schema.ts` change run `pnpm db:generate` — it runs fine without a TTY for adds/drops/creates
  (and from-scratch squashes); it only prompts on **ambiguous renames** (an added+removed pair it
  can't tell apart). There is no non-interactive flag for that case (drizzle-orm#2624 wishlist) —
  resolve a rename as add + copy + drop, or `--custom` and hand-write the SQL. **Migrations are append-only once released** — never edit an
  applied migration (drizzle tracks by content hash, so an edited baseline won't re-run on an
  existing DB and the column silently never lands); add a new `NNNN_*.sql`. (The 1.0 baseline is a deliberate squash:
  pre-1.0 DBs are NOT auto-upgradable — fresh DB or manual export/import — and the baseline's
  fresh journal timestamp makes an old DB fail loudly at boot rather than silently skip. The
  append-only rule applies from this baseline forward.) Identity uniqueness is the
  `(auth_provider, auth_subject)` index. **libSQL `:memory:` breaks across `db.transaction()`** —
  prefer atomic single statements in tests over transactions.

## Testing

Vitest, node environment. Test glob: `src/{server,shared,db,client}/**/*.test.ts`. Client tests are
**pure-logic only** (no DOM) — React component tests (`*.test.tsx`, jsdom) are intentionally not set
up yet. narratorr is exercised via the MSW fixture.

## Git / releases

- **Branches:** `main` = trunk (released/deployed, default branch) · `develop` = active dev. Work on
  `develop`, merge to `main` at milestones, **tag on `main`**.
- **Tags are the version of record** (`package.json` stays `0.1.0`). CI publishes `:latest` + the
  semver tag on tag push → the deployment pulls `:latest` and migrations apply on
  boot. **So tagging effectively deploys** — only tag a green `pnpm verify`.
- **Commits:** imperative mood; **no `Co-Authored-By` lines**.

## Cross-repo coordination

narratorr (the sibling project this app plugs into) owns the `/api/v1` contract; we vendor the
subset we consume. The durable spec on our side is the vendored Zod under `src/shared/schemas/v1/`
(it mirrors narratorr's own layout so it can lift into a shared `@narratorr/api-contract` package
later). Planning and review scratch docs are kept out of the repo (see `.gitignore`).
