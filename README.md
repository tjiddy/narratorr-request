# narratorr-requests

An [Overseerr](https://overseerr.dev/)-style request manager for
[Narratorr](https://github.com/tjiddy/narratorr) (Sonarr/Radarr for audiobooks). Family and friends sign in
(local email/password or any OIDC provider — Plex bridge, Authelia, Authentik, Google, …),
search/browse audiobooks, and request them. New users land in an **approval queue** until an
admin lets them in; an admin then approves each request (admins and auto-approve users skip the queue); approved
requests hand off to Narratorr's `search → download → import` pipeline, and the requester tracks
progress to **available** on their **My requests** page. Admins get notified (new request to
review, new signup, failed acquisition) over any notifiers they add; requesters can opt in — via
the account modal behind their username — to be emailed when their request is **approved**,
**denied**, or **ready to listen**.

It is a **plug-in sidecar** that talks to Narratorr only over its public `/api/v1` HTTP
surface (API key). It has no other coupling. The Narratorr connection and the notifiers
(a list of ntfy / email / webhook destinations, each routed to the events it fires on) are configured in the in-app **Settings** page after first
boot — not via environment variables — and stored encrypted in the DB, so spinning it up
takes a minimal env (a session secret + auth) and the rest is point-and-click.

## Contract-first

The `/api/v1` surface this app consumes is vendored as Zod schemas under
[`src/shared/schemas/v1/`](src/shared/schemas/v1/) (+ [`book.ts`](src/shared/schemas/book.ts)),
mirroring Narratorr's own schema layout so the contract lifts cleanly upstream. The matching
**MSW handlers** (`src/server/mocks/narratorr-v1.ts`) are a **test fixture** — they back the
contract tests; there is no mock runtime mode.

See [`CLAUDE.md`](CLAUDE.md) for the architecture, conventions, and the contract/auth model.

## Run it (local dev)

```bash
pnpm install
cp .env.example .env          # AUTH_BYPASS=1 is the default — seeds a dev admin
pnpm db:migrate               # create/upgrade the sqlite db
pnpm dev                      # server :3000, client :5173
```

Open http://localhost:5173, then go to **Settings** and enter a Narratorr URL + API key
(use **Test** to verify) to enable search and requests. Add a notifier the same way — pick a
type, choose which events it fires on, and **Test** before saving. Until Narratorr is
configured, search/requests return a "not connected yet" notice.

## Auth

Authentication (who you are) is **pluggable**; authorization (who may request) is the in-app
**approval queue**. The two are independent.

- **Methods** — enable either or both:
  - **Local** email/password (`LOCAL_AUTH=true`, the default). Email is the login + contact;
    the first signup becomes admin.
  - **OIDC** — list provider ids in `OIDC_PROVIDERS` and configure each with `OIDC_<ID>_*`
    (issuer / client id / secret / redirect uri / label, plus optional claim overrides). Plex
    (via the bridge), Authelia, Authentik, Keycloak, Pocket-ID, Google, … are all just provider
    instances. Each gets a login button and a callback at `/api/auth/oidc/<id>/callback`.
- **Approval queue** — a new user can sign in but lands `pending` and can't search or request
  until an admin approves them on the **Users** page (reject is durable). The **first** user in
  any method becomes admin + active automatically. For a public/open IdP, set
  `BOOTSTRAP_ADMIN=<provider>:<subjectOrUsername>` to claim admin deterministically (this
  disables first-user-auto-admin so a stranger can't grab it by signing in first).
- **Dev** — `AUTH_BYPASS=1` seeds a dev admin and makes every request that admin, so it's
  refused in production and on non-loopback binds.
- Behind a reverse proxy, set `TRUSTED_PROXIES` (same var name as narratorr) so the real client IP is used for the login
  rate-limit. See [`.env.example`](.env.example) for copy-paste presets.

> Single-instance note: OIDC login state and the auth rate-limiter are in-memory, so running
> multiple replicas needs sticky sessions (a shared store is a future enhancement).

## Settings (in-app)

The admin **Settings** page configures, and stores encrypted at rest:

- **Narratorr connection** — base URL + API key (the lifeline; required for search/requests).
- **Notifiers** — a list of destinations (ntfy, email/SMTP, generic/Discord webhook). Each has a name, an enabled toggle, the events it fires on (new request / new signup), and a **Test** button — add as many as you like, including several of the same type routed to different events. The email/SMTP notifier also delivers the **requester opt-in emails** (approved / denied / ready-to-listen) to each user's own contact address.
- **Public URL** — used to deep-link notifications back to the request queue.

Secrets are never returned to the browser (the form shows `•••••••• (unchanged)`). The at-rest key
comes from `SETTINGS_KEY`, or is derived from `SESSION_SECRET` when that's unset — see the
caveat in [`.env.docker.example`](.env.docker.example).

## Docker

A single container runs everything (Fastify API + the built SPA), with the libSQL file on a
named volume and migrations applied on boot.

**Smoke test (boots into the admin UI, zero config):**

```bash
docker compose up --build      # http://localhost:3000
```

Out of the box this runs in **AUTH_BYPASS** mode (seeded dev admin) so you can confirm the
image runs and serves the UI. `/api/health` reports readiness (it pings the DB and reports
`narratorrConfigured`), and the container has a matching `HEALTHCHECK`. Configure Narratorr in
Settings to actually request anything.

**Real deployment:**

```bash
cp .env.docker.example .env     # fill SESSION_SECRET (+ SETTINGS_KEY), pick an auth method
#                                 (LOCAL_AUTH and/or OIDC_*), set NODE_ENV=production, AUTH_BYPASS=0
docker compose up -d --build
# then open the app, sign in (first user = admin), and configure Narratorr + notifications in Settings
```

In production the app **refuses to start** without a `SESSION_SECRET`, refuses `AUTH_BYPASS`
entirely, and requires at least one auth method (`LOCAL_AUTH` or an OIDC provider) — so a
misconfigured deployment fails fast rather than exposing an open admin. The build is a 3-stage
`node:24-slim` image that runs as the non-root `node` user; the DB persists in the
`narratorr-requests-data` volume (`/data`).

> **Upgrading:** migrations apply automatically on boot and are **forward-only** (no
> down-migrations). Before upgrading a populated instance, **snapshot the
> `narratorr-requests-data` volume**; to roll back, restore that snapshot and redeploy the
> previous image (an older image can't run against a newer schema).

### Published images

CI (`.github/workflows/docker.yml`) builds a multi-arch (amd64/arm64) image and pushes to
**Docker Hub `narratorr/narratorr-requests`** and **GHCR `ghcr.io/tjiddy/narratorr-requests`**:

- **Release** — push a semver tag on `main` (`git tag v1.0.0 && git push origin v1.0.0`) → `:latest`,
  `:1.0.0`, `:1.0` + a GitHub Release.
- **Bleeding edge** — every push to `develop` (or a manual workflow run) → `:develop`.

Quality gates (lint/typecheck/test/build) run first, and the pushed image is smoke-tested before
the job succeeds. Requires repo secrets **`DOCKERHUB_USERNAME`** and **`DOCKERHUB_TOKEN`**.

## Verify

```bash
pnpm verify   # lint + test + typecheck + build
```

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (branch off `develop`) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue? See [SECURITY.md](SECURITY.md) —
please report privately, not as a public issue.

## License

[GPL-3.0](LICENSE) © Todd Johnson
