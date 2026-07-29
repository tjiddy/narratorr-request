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

## zod-nested-catch-containment

**source:** #140  
**added:** 2026-07-28  
**files:** src/shared/schemas/v1/metadata.ts  
**tags:** zod-v4, vendored-contract, schema-leniency, catch

---

Zod's `.catch(fallback)` on an object recovers the WHOLE object, never one member. When you add a new member to a vendored object that already carries `.catch(undefined)` — e.g. `v1AudibleResultSchema.library` in `src/shared/schemas/v1/metadata.ts` — the existing outer catch does NOT protect its siblings from the new member: any drift on the new field fails the whole object, the outer catch swallows it, and every consumer of the parent silently degrades. For `library` that means `resolveBookCardState` (`src/client/components/book-card-state.ts`) loses the 'In library' / 'On the way' badge for every search result, with no error and no log line.

Rule: every drift-prone member added inside a `.catch()`-guarded vendored object gets its OWN inner catch — `member: memberSchema.nullable().optional().catch(undefined)`. The inner catch confines drift to that member.

This matters most where the guarded schema is load-bearing rather than decorative: `v1BookSchema` (`./books.ts`) backs `addBook()` and the poller's `getBook()`, so an uncaught drift there is a `502 CONTRACT_MISMATCH` that strands a request at `acquiring` indefinitely.

Testing it: a containment test must assert the SIBLINGS survive, not just that the new field is undefined — the latter passes vacuously before the field is even declared, because non-`.strict()` schemas strip unknown keys. See 'confines companion drift to the companion field' in `src/shared/schemas/v1/metadata.test.ts`, which drives three drift shapes (wrong literal value, garbage scalar, missing required member) and asserts `bookId`/`status` intact. Confirm it is a genuine red by deleting the inner `.catch(undefined)` and rerunning.

## nonstrict-response-schema-masks-mapper-leak

**source:** #142  
**added:** 2026-07-28  
**files:** src/server/services/user.service.ts  
**tags:** zod, fastify-type-provider-zod, dto-mapper, pii-exposure, test-design

---

A field-exposure test asserted at the ROUTE BOUNDARY cannot detect a leaking DTO mapper. `userDtoSchema` (src/shared/schemas/user.ts) is a non-`.strict()` `z.object`, and fastify-type-provider-zod's serializerCompiler parses handler return values through it — Zod strips unknown keys by default. So if `UserService.toDto` (src/server/services/user.service.ts) grows a self-scoped key, `GET /api/admin/users` and `PATCH /api/admin/users/:publicId` bodies are byte-identical and every `expect(res.payload).not.toContain(secret)` assertion stays green.

Whenever a column is 'self-scoped only' (on `MeDto`, not on the admin `UserDto`), pin non-exposure with a DIRECT assertion on the mapper:

    const row = await h.users.getById(seeded.id);
    expect(row?.kindleEmail).toBe(KINDLE);      // the source genuinely has it
    expect('kindleEmail' in h.users.toDto(row!)).toBe(false);

Keep the route-body assertions too (they catch a leak via any other path), but the mapper assertion is the load-bearing one. Existing examples: the `passwordHash` pair and the `kindleEmail` trio in `src/server/routes/admin.route.test.ts`. Verified in #142 by mutation-testing: adding `kindleEmail` to `toDto` fails ONLY the direct assertion.

Corollary: don't reach for `.strict()` on a response schema to close this. The stripping is genuine defence-in-depth at runtime, `.strict()` would turn a benign extra key into a 500, and it conflicts with the repo's consumer-lenient contract discipline. Fix the test, not the schema.

## concurrent-mutations-full-dto-cache-rollback

**source:** #142  
**added:** 2026-07-28  
**files:** src/client/hooks.ts  
**tags:** react-query, tanstack-query, setQueryData, concurrency, optimistic-cache

---

Two `useMutation` instances writing the same query key will overlap, and `onSuccess: dto => qc.setQueryData(key, dto)` makes the LAST response win for every field — including fields that response never wrote. When the server re-reads and returns a full DTO, an earlier-dispatched request carries the sibling field's pre-write value, so settling last silently rolls back the newer save. The UI symptom is a row that reverts and goes falsely dirty: its draft was reconciled correctly, but the cache it compares against was clobbered.

The trigger is specifically: (a) two or more independently-triggered mutations, (b) one shared cache entry, (c) success handler replaces the entry wholesale. Giving each form row its own mutation instance — a reasonable thing to do so one row's in-flight save doesn't disable another's button — creates (a) on its own.

Fix by folding field-wise on the request body rather than replacing. A response is authoritative only for the fields its own body wrote:

    export function mergeMeCache(prev: MeDto | undefined, dto: MeDto, body: UpdateMeBody): MeDto {
      if (!prev) return dto;
      return {
        ...dto,
        ...(!('email' in body) && { email: prev.email, emailNotifyAvailable: prev.emailNotifyAvailable }),
        ...(!('kindleEmail' in body) && { kindleEmail: prev.kindleEmail }),
        ...(!('notifyOn' in body) && { notifyOn: prev.notifyOn }),
      };
    }

    qc.setQueryData<MeDto>(qk.me, (prev) => mergeMeCache(prev, dto, body));

Carry any DERIVED field with its source (`emailNotifyAvailable` moves with `email`). Key on the KEY's presence, not its value, so an explicit `null` clear stays an authoritative write. Fields the endpoint doesn't write (quota, identity) can still take the fresher response. This keeps the direct cache write — no `invalidateQueries` refetch round-trip — and lets the mutations stay independent.

Test it at both layers: a pure order-convergence property (applying both responses in either order yields the same cache) and a component test that freezes response snapshots at dispatch time and releases them in reverse. Seen in #142 (`useUpdateMe` / AccountModal's contact + Kindle rows). Wholesale replacement remains fine where only ONE mutation instance can ever write the key — e.g. `useUpdateConnectors`.

## addressparser-splits-not-validates

**source:** #143  
**added:** 2026-07-28  
**files:** src/server/services/notifications/kindle-sender.ts  
**tags:** nodemailer, addressparser, email-validation, zod

---

`nodemailer/lib/addressparser` (nodemailer@9.0.1) SPLITS an address header into parts; it does not validate them. When the input contains an `@` it falls back to returning that text verbatim as the `address`, so `'a@'`, `'@example.com'`, `'a@b'`, and `'a@b@c'` each parse to exactly ONE entry with a non-empty `address` — a `parsed.length === 1 && parsed[0].address` check accepts all four.

Two rules when parsing an operator-supplied `from`/address field:

1. **Structural gate** — require exactly one entry that has no `group` member and a non-empty `address`. Do NOT use `{ flatten: true }`: it silently promotes a one-member group (`'Undisclosed:a@x.com;'`) to a valid-looking single address. Also note `''`/whitespace parses to `[]`, and a bare token like `'ops team'` parses to one entry whose `address` is `''`.
2. **Validity gate** — follow it with this repo's single mailbox-validity predicate, `hasDeliverableContact` (`src/shared/schemas/user.ts`, derived from `contactEmailSchema`: trim + lowercase + `z.email()` + max-254), already shared by local login, the OIDC email gate, and the availability sweep. Use it as a PREDICATE only and return the parser's `address` verbatim, so storage/display keep the original casing while comparisons lowercase both sides.

Reference implementation + case table: `parseSingleMailbox` in `src/server/services/notifications/kindle-sender.ts`, tests in `kindle-sender.test.ts` (dropping the `hasDeliverableContact` call is a verified genuine red for the four malformed-`@` cases). `import addressparser from 'nodemailer/lib/addressparser/index.js'` typechecks as-is here; `@types/nodemailer` ships the declaration. nodemailer is Node-only — this must stay server-side and never reach `src/client`/`src/shared`.

## narratorr-client-per-consumer-slices

**source:** #144  
**added:** 2026-07-28  
**files:** src/server/services/narratorr-client.ts  
**tags:** typescript, narratorr-client, test-doubles, interface-design

---

`INarratorrClient` in `src/server/services/narratorr-client.ts` is a broad `Pick<NarratorrClient, ...>`. Adding a method to it structurally breaks every hand-rolled test double that declares `implements INarratorrClient` or types an object literal as it — even doubles that never call the new method. Adding `getCapabilities` (issue #144) broke six test files, ~100 call sites in `request.service.test.ts` alone.

Prefer PER-CONSUMER slices: each service depends only on the calls it makes, so widening the full interface costs nothing downstream. Established slices: `IMetadataSearchClient` (SearchService), `IBookHandoffClient` (RequestService), `IBookStatusClient` (StatusPoller), `ICapabilityClient` (FeatureService). `NarratorrClientHolder` implements the full interface, so production wiring is unchanged and only genuine full-client consumers (`route-harness.ts`'s FakeNarratorrClient, `requests.route.test.ts`, `system.route.test.ts`, `narratorr-client-holder.test.ts`) must grow a new member.

When adding a method (e.g. #145's raw streaming client): add it to `NarratorrClient` and `INarratorrClient`, forward it on the holder, add a slice for its consumer, and update only the full-client doubles. Check the blast radius with `pnpm typecheck` — vitest does not typecheck, so this class of break is invisible to a green test run.

## react-query-mock-hides-cache-convergence

**source:** #144  
**added:** 2026-07-28  
**files:** src/client/hooks.test.ts  
**tags:** react-query, vitest, test-infra, cache-invalidation, jsdom

---

`src/client/hooks.test.ts` mocks `@tanstack/react-query` wholesale — `useQueryClient()` returns `{invalidateQueries: vi.fn(), setQueryData: vi.fn()}`, `useQuery`/`useMutation` return their options object. This is the right modality for asserting a hook's shape (query key, `queryFn`, `enabled`, which cache operation a mutation requests, toast text) and it is structurally INCAPABLE of asserting what the cache converges on: there is no QueryCache, no observer, no refetch.

So a reverse-settlement / lost-update regression test written in this file is vacuous — it passes whether or not the defect exists. This is not hypothetical: #144 F1 (PR #165) was blocked for precisely this, a test asserting `invalidateQueries` was called while `useUpdateConnectors` still did `setQueryData(qk.connectors, dto)` and could clobber a sibling's committed field.

When the assertion is about a FINAL CACHE VALUE after two responses settle in a given order, write a `.test.tsx` in the jsdom project using the real `QueryClient` + `QueryClientProvider` + `renderHook`. Exemplar: `src/client/hooks.connector-cache.test.tsx`. Two setup requirements:
  • Mount the reader and every mutation in ONE `renderHook` call. Separate roots re-render independently, so a cache correction that reaches one is not observable through another's `result.current`.
  • `await waitFor()` around the post-settle read — `result.current` only refreshes on re-render.
Model the hazard by having the fake server commit a PUT body to an authoritative row immediately but resolve its RESPONSE through a deferred the test releases, snapshotting the response body at commit time; that reproduces "a response computed before a sibling's write, delivered after it".

This refines [[frontend-logic-extract-not-jsdom]], which endorses `hooks.test.ts` for mutation lifecycle — that endorsement holds for lifecycle and payload shape, not for cache-state convergence. Related defect pattern: learning #160 (independent mutations replacing a shared full-DTO entry).

## settings-routes-commit-before-fallible-tail

**source:** #144  
**added:** 2026-07-28  
**files:** src/server/routes/settings.ts  
**tags:** react-query, fastify, cache-invalidation, error-handling, settings-routes

---

Every write path in `src/server/routes/settings.ts` is ordered persist-then-fallible-tail: the connectors PUT does `await connectorSettings.update(body)` and only then `await reconfigure(...)`; notifier create/update/delete follow the same shape. `reconfigure()` awaits `getNotificationsConfig()` and `getDefaultQuota()` after swapping the narratorr holder, so either can reject and turn an already-committed write into a 500.

**A 500 from these routes is not evidence that nothing was written.** The `survives a REJECTING <method> tail` rows in `settings.route.test.ts` assert exactly that pairing — 500 returned, write durable, capability generation already bumped.

So client cache reconciliation for these endpoints belongs on `onSettled`, never `onSuccess`. Reconciling only on success strands the SPA on pre-write state for a change that landed, with nothing scheduled to repair it (a `staleTime` lapse only MARKS data stale — it schedules no refetch). This was PR #165 findings F5/F6.

Pattern: `src/client/hooks.ts` exposes `reconcileConnectorWrite(qc, retiresCapability)`, called from `onSettled` by all six settings/notifier mutations; toasts stay on `onSuccess`/`onError`. `onSettled` receives `(data, error, variables)`, so a body-keyed trigger like `body.narratorr !== undefined` (mirroring the server's own `reconfigure(narratorrChanged)`) still works on the error path. Refetching after a genuine 400 costs one GET returning the unchanged row; a client cannot reliably infer from a status code which failures committed, so always reconcile.

Known related instances NOT yet converted: `useRequestBook` / `useDecide` (`RequestService.create()` inserts then runs a fallible auto-approve `handoff()`, so the route 502s post-commit). Distinct from [[react-query-mock-hides-cache-convergence]] (a test-modality blind spot) and from learning #160 (`setQueryData` vs `invalidate` on a shared entry) — this is a third axis: WHEN to reconcile, not how or with what.

## fastify-hijack-for-no-response

**source:** #146  
**added:** 2026-07-28  
**files:** src/server/routes/ebooks.ts  
**tags:** fastify, reply-lifecycle, client-disconnect, streaming

---

In Fastify 5, a route handler cannot decline to respond by returning early. `wrap-thenable.js` calls `reply.send(undefined)` whenever the handler resolves with `undefined` and the reply is not sent/hijacked and the socket is not destroyed — producing an empty 200. Use `reply.hijack()` (then `return`) for a genuine no-response branch; it sets `kReplyHijacked`, which `wrapThenable` checks FIRST, and it also clears the handler timeout and abort listener.

Two related facts that matter for disconnect handling:

1. `reply.sent` is `kReplyHijacked || raw.writableEnded` (`lib/reply.js:98-103`), which is FALSE for a socket the client destroyed. Fastify therefore still runs your handler after a disconnect — a `close` listener installed inside the handler is too late to observe a `close` that fired during the auth/limiter hooks, so derive liveness from STATE (`request.raw.aborted || reply.raw.destroyed || controller.signal.aborted`) and seed an AbortController from it on entry.
2. `Reply.prototype.then` (`lib/reply.js:466`) short-circuits to `fulfilled()` when `sent` is true, but otherwise waits on `eos(this.raw)` — the whole response. So `await reply.hijack()` is instant while `await reply.send(webStream)` blocks until the transfer finishes. Do NOT silence `@typescript-eslint/return-await` on a `return reply.send(...)` by adding `await`; restructure so the send is outside the try/catch instead.

See the two AC26 seams in `src/server/routes/ebooks.ts` and the `sent === 0` receipts in `src/server/routes/ebooks.stream.route.test.ts`.

## vitest-tofake-date-only

**source:** #146  
**added:** 2026-07-28  
**files:** src/server/routes/ebooks.route.test.ts  
**tags:** vitest, fake-timers, fastify-rate-limit, ambient-clock

---

When a test must pin behaviour that depends on time, prefer this repo's existing idiom: inject the instant as a trailing default parameter (`ebooksCapability(nowMs = Date.now())`, `SearchService.search`, `createSessionToken`). No fake timers, no globals.

That only works for first-party code. When the clock lives in a dependency — e.g. `@fastify/rate-limit@11`, whose LocalStore reads ambient `Date.now()` at `store/LocalStore.js:12` to choose a window bucket and offers no injection point — use `vi.useFakeTimers({ toFake: ['Date'], now: <Date> })`.

`toFake: ['Date']` is the load-bearing part. Plain `vi.useFakeTimers()` also fakes `setTimeout`/`setInterval`/`setImmediate`, which stalls anything real in the test: a Fastify instance from `buildRouteApp`, drizzle/libSQL migrations, `inject()`, and any actual socket I/O. The test then hangs rather than failing honestly. Faking Date alone leaves the event loop intact.

Two follow-ups worth doing every time:

1. Restore with `vi.useRealTimers()` in a describe-scoped `afterEach` — `vi.restoreAllMocks()` does NOT restore timers, so the frozen clock leaks into the rest of the file.
2. Once the clock is yours, MOVE it: `vi.setSystemTime(frozen + windowMs + 1_000)` and assert the limit resets. That upgrades the freeze from defensive to asserted and pins the configured window's real value instead of trusting the exported constant.

Worked example: the `rate limiting, per user (AC29-AC31)` describe in `src/server/routes/ebooks.route.test.ts`.

## synchronize-dependent-query-before-absence-assert

**source:** #147  
**added:** 2026-07-29  
**files:** src/client/pages/SearchPage.test.tsx  
**tags:** react-query, vitest, jsdom, testing-library, test-assertions

---

A synchronous `queryBy*` absence assertion is only meaningful once you have PROVEN the app is in the state you think it is. Awaiting an element fetched by a DIFFERENT query does not establish that — it is a race you usually win, not a synchronization point.

This is the complement to the existing `vi.waitFor cannot assert an absence` learning (#176): that one says make the negative assertion synchronous; this one says you must first prove the terminal state, or the synchronous assertion just observes `pending`.

Concretely, `useFeatures(me)` is gated on `/api/me` resolving, while `useSearch` / `useMyRequestsPaged` fire independently — and `ebooksVisible()` returns false for BOTH `pending` and `error`, so a test that awaits a row and then asserts no affordance passes whether or not the feature request ever settled.

The shape (see `src/client/pages/SearchPage.test.tsx` and `MyRequestsPage.test.tsx`):

```ts
// stub: return a deferred the test owns
if (url.startsWith('/api/features')) return new Promise<Response>((r) => { settleFeatures = r })

async function settleFeaturesTo(client: QueryClient, response: Response, status: 'success' | 'error') {
  await waitFor(() => expect(settleFeatures).not.toBeNull())   // the request was issued
  await act(async () => { settleFeatures!(response) })
  await waitFor(() => expect(client.getQueryState(qk.features)?.status).toBe(status))
  await act(async () => {})                                     // flush the scheduled render
}
```

For a genuine loading case, assert `getQueryState(key)?.status === 'pending'` AND that the request was issued — otherwise "loading" is indistinguishable from "the query never started". Needs `retry: false` on the test `QueryClient` so a 5xx reaches `error` in one tick.

How to check such a test is not vacuous: mutate the gate so it fails ONLY in the branch under test (e.g. `ebooksVisible` -> `state.isError === true || state.data?.ebooksEnabled === true`) and confirm exactly that case goes red. On #147 this exposed a MyRequestsPage error-state test that stayed green while the affordance was fully regressed.
