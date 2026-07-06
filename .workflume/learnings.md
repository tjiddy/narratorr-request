# Learnings

Curated, durable engineering wisdom for narratorr-requests — lessons worth carrying into
future work. One `## slug` heading per entry (slug must contain a hyphen), then metadata, a
`---`, and a free-form body. The `files`/`tags` on each entry scope it to the code it applies
to, so the relevant lesson can be surfaced when that area is next touched.

## frontend-logic-extract-not-jsdom

**source:** #7
**added:** 2026-06-23
**files:** src/client/
**tags:** testing, frontend, react, vitest, test-infra

---

Frontend regression risk lives in **payload / decision logic** (mutation request bodies,
parse-and-guard, sort/format, conditional defaults) — not in rendering. Extract that logic
into pure functions with co-located `.test.ts` coverage. This repo already follows the
pattern: `build*` / `init*` payload helpers in `src/client/pages/settings-channels.ts` and
`settings-narratorr.ts`, mutation lifecycle in `hooks.test.ts`.

The repo deliberately has **no** jsdom / `@testing-library/react` / `user-event` modality
(vitest is a single node project, `.test.ts`-only glob). That is the **intended
architecture**, not a coverage gap. A typed mutation payload is already guarded by typecheck
+ the server's Zod validation (a malformed body 400s, it doesn't silently corrupt), so a
behavior-preserving extraction can't silently drop a payload past those gates.

Reach for jsdom only when a feature has genuine **DOM-only** logic that can't be a pure
function: complex conditional rendering, focus/keyboard handling, or multi-step side-effect
orchestration (e.g. a logout flow chaining clear → navigate → reload with an error path).
When an auto-filed finding says "no component-test modality," first triage what decision
logic is **already pure-testable / pure-tested** — usually the high-value part is covered and
standing up the whole harness is belt-and-suspenders. Prefer extracting one more pure helper
over adding a test modality.

## triage-autofiled-debt-by-proportionality

**source:** #35, #48, #7
**added:** 2026-06-23
**files:** src/shared/schemas/, src/server/services/
**tags:** triage, debt, security, ssrf, validation, proportionality

---

Auto-filed `[debt]` findings (from audits, linters, or review tooling) are reliably accurate
about the **fact** of a gap but tend to **over-scope the fix**. Triage each against (a) real
exploitability/impact and (b) whether the proposed remedy is proportionate — *before* acting.
A real gap does NOT imply the filed fix is worth building.

Cases this repo hit:

- **coverUrl DNS-rebinding (#35)** — real residual, but both sinks are **blind/opaque with no
  response readback**: the `<img src>` is the admin's browser (CSP `imgSrc` https-only + schema
  https + opaque load, needs browser-trusted TLS on the internal host) and the ntfy `Icon` is
  fetched by ntfy's server, not ours. Impact ≈ a single blind internal GET by an
  already-approved user. The proposed server-side image proxy would have added a *new* SSRF
  surface to defend a blind GET → closed not-planned as a documented residual (SECURITY.md).
- **narratorr Host validation (#48)** — three claimed cases, but only **bare-IPv6 bracketing**
  was worth fixing; embedded-port/userinfo are user-error on a labeled field, caught instantly
  by the Test button. Rescoped to the one real slice.

Specific hazard: letting an over-scoped finding proceed to implementation risks actually
**building the disproportionate remedy** (e.g. an image proxy nobody wants). When a finding's
fix is bigger than its impact, rescope the issue to the real slice or close it not-planned with
the reasoning — don't let it ride into implementation unexamined.

## msw-cannot-test-body-read-abort

**source:** #95
**added:** 2026-07-02
**files:** src/server/services/narratorr-client.test.ts
**tags:** msw, undici, abort-signal, fetch, vitest, timeout

---

MSW (setupServer, v2.14.6) cannot exercise an undici body-read abort. It honors
`AbortController.abort()` only while a handler resolver is still pending — it can't interrupt an
already-returned in-memory ReadableStream body — and `passthrough()` re-buffers the upstream
response before resolving the caller's `fetch()`. So any test of "headers flush, then the body
stalls past the deadline" behaves identically for correct and broken code under MSW (the abort
always lands in `fetch()`, never in `res.text()`), making it vacuous.

To test read-deadline / mid-stream cancellation behavior, use a real ephemeral `node:http` server
and take MSW out of the loop for that request: `server.close()` before it (restores native fetch)
and `server.listen({ onUnhandledRequest: 'error' })` in a `finally` to re-arm MSW for the remaining
tests in the file (tests in a file run serially, so this is safe). Have the server flush headers +
a partial body immediately, then complete the body after a fixed delay; pick a `timeoutMs` with
headroom over localhost connection setup (100ms, not 10ms — a too-tight deadline races the abort
into `fetch()` and defeats the test). See the body-stall test in
`src/server/services/narratorr-client.test.ts`. Verify the test is a genuine red by stashing the
production fix and rerunning.

## sqlite-check-null-is-satisfied

**source:** #81
**added:** 2026-06-25
**files:** src/db/schema.ts
**tags:** sqlite, libsql, drizzle, check-constraints

---

SQLite/libSQL CHECK constraints reject a row ONLY when the predicate evaluates to FALSE — a NULL
result is treated as satisfied (passes). So a coherence check over a nullable column written as
`(mode='x' AND n>0) OR (mode<>'x' AND n IS NULL)` has a silent hole: for `mode='x'` with
`n IS NULL` it evaluates to NULL (`TRUE AND NULL` → NULL; the other limb is FALSE; `NULL OR FALSE`
→ NULL) and the incoherent row slips through. Write coherence checks in a never-NULL boolean form
instead, e.g. `(mode='x') = (n IS NOT NULL) AND (n IS NULL OR n > 0)` — the `=` between two boolean
sub-expressions can never be NULL. Verify every corner against an in-memory libSQL DB applying the
generated migration, since drizzle renders the JS `check()` SQL verbatim. Seen on the
`request_quota` / `default_quota` mode↔limit constraints in `src/db/schema.ts` (#81).
