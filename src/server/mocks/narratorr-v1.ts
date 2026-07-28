import { http, HttpResponse, type RequestHandler } from 'msw';
import type { V1AudibleResult } from '../../shared/schemas/v1/metadata.js';
import { ADD_BOOK_ERROR_CODES, type AddBookErrorCode, type V1Book } from '../../shared/schemas/v1/books.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { V1CompanionEbook } from '../../shared/schemas/v1/companion-ebook.js';
import { errorBody, type ErrorEnvelope } from '../../shared/schemas/v1/common.js';
import { publicId } from '../util/ids.js';
import { MOCK_BASE_URL } from './constants.js';

// TEST FIXTURE ONLY. These handlers back the contract tests (narratorr-client.test.ts
// etc.) — there is no standalone runtime mode anymore; production always talks to a
// real narratorr configured via the Settings UI. MOCK_BASE_URL lives in ./constants so
// it's importable without pulling msw into a runtime path.
export { MOCK_BASE_URL };

// ---------------------------------------------------------------------------
// Fixtures — a small mock Audible catalog. ASINs in PRE_IMPORTED simulate a book
// Narratorr already imported, so re-requesting one exercises the "already
// available" path (POST /books returns an `imported` book, no re-grab).
// ---------------------------------------------------------------------------
const CATALOG: V1AudibleResult[] = [
  {
    asin: 'B07KCQDQR9',
    title: 'Project Hail Mary',
    authors: [{ name: 'Andy Weir' }],
    narrators: [{ name: 'Ray Porter' }],
    cover: null,
    duration: 58980,
    publishedDate: '2021-05-04',
    language: 'english',
  },
  {
    asin: 'B002V1A0WE',
    title: 'The Name of the Wind',
    authors: [{ name: 'Patrick Rothfuss' }],
    narrators: [{ name: 'Nick Podehl' }],
    cover: null,
    duration: 97860,
    publishedDate: '2009-08-04',
    series: { name: 'The Kingkiller Chronicle', position: 1 },
    language: 'english',
  },
  {
    asin: 'B0182AKKQQ',
    title: 'The Wise Man’s Fear',
    authors: [{ name: 'Patrick Rothfuss' }],
    narrators: [{ name: 'Nick Podehl' }],
    cover: null,
    duration: 152760,
    publishedDate: '2011-03-01',
    series: { name: 'The Kingkiller Chronicle', position: 2 },
    language: 'english',
  },
  {
    asin: 'B017V4IM1G',
    title: 'Mistborn: The Final Empire',
    authors: [{ name: 'Brandon Sanderson' }],
    narrators: [{ name: 'Michael Kramer' }],
    cover: null,
    duration: 88260,
    publishedDate: '2010-08-04',
    series: { name: 'Mistborn', position: 1 },
    language: 'english',
  },
  {
    asin: 'B0036I54I6',
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson' }],
    narrators: [{ name: 'Kate Reading' }, { name: 'Michael Kramer' }],
    cover: null,
    duration: 161940,
    publishedDate: '2010-08-31',
    series: { name: 'The Stormlight Archive', position: 1 },
    language: 'english',
  },
  {
    asin: 'B00OXWYU0M',
    title: 'Red Rising',
    authors: [{ name: 'Pierce Brown' }],
    narrators: [{ name: 'Tim Gerard Reynolds' }],
    cover: null,
    duration: 56040,
    publishedDate: '2014-01-28',
    series: { name: 'Red Rising Saga', position: 1 },
    language: 'english',
  },
  {
    asin: 'B075FYBP8H',
    title: 'Dune',
    authors: [{ name: 'Frank Herbert' }],
    narrators: [{ name: 'Scott Brick' }, { name: 'Euan Morton' }],
    cover: null,
    duration: 75660,
    publishedDate: '2007-11-02',
    series: { name: 'Dune', position: 1 },
    language: 'english',
  },
  {
    asin: 'B008V94T9M',
    title: 'The Lies of Locke Lamora',
    authors: [{ name: 'Scott Lynch' }],
    narrators: [{ name: 'Michael Page' }],
    cover: null,
    duration: 80820,
    publishedDate: '2012-09-04',
    series: { name: 'Gentleman Bastard', position: 1 },
    language: 'english',
  },
];

const byAsin = new Map(CATALOG.map((f) => [f.asin, f]));

// Marker ASINs that drive each as-shipped 422 add-error code (narratorr #1545), so every
// handoff branch and friendly message is reachable from a fixture path. Any OTHER unknown
// ASIN defaults to `asin_not_resolved` (the real-world "provider can't resolve it" case).
const ADD_ERROR_MARKERS: Record<string, AddBookErrorCode> = {
  B000EDITIONX: ADD_BOOK_ERROR_CODES.editionRejected,
  B000INVALIDX: ADD_BOOK_ERROR_CODES.invalidRecord,
  B000NORESOLV: ADD_BOOK_ERROR_CODES.asinNotResolved,
};

// ASINs that simulate books Narratorr has already imported (status is immediately
// `imported`).
const PRE_IMPORTED = new Set<string>(['B017V4IM1G', 'B075FYBP8H']);

// ---------------------------------------------------------------------------
// Companion ebooks (narratorr #1961). ASIN → the companion value narratorr advertises.
// ONE table feeds both surfaces (the search `library` annotation and the book DTO), so
// the two can never disagree for the same ASIN.
//
// narratorr exposes a companion only when `enabled && imported && available`, so
// `companionFor()` gates on the PROJECTED status and the designated ASINs are drawn from
// PRE_IMPORTED — the fixture can never emit a companion on a `searching`/`downloading`
// book, a state narratorr itself never produces.
//
// The three UI states downstream stories render are all reachable here:
//   - in library WITH a companion  → B017V4IM1G (Mistborn)
//   - in library WITHOUT one       → B075FYBP8H (Dune, pre-imported, absent from the table)
//   - not in library at all        → any ASIN that hasn't been added (no `library` key)
// ---------------------------------------------------------------------------
const COMPANION_EBOOKS: Record<string, V1CompanionEbook> = {
  B017V4IM1G: { format: 'epub', sizeBytes: 4096 },
};

function companionFor(asin: string, status: BookStatus): V1CompanionEbook | null {
  if (status !== 'imported') return null;
  return COMPANION_EBOOKS[asin] ?? null;
}

/**
 * Marker publicIds reaching the companion-epub handler's non-404 negatives, in the spirit
 * of ADD_ERROR_MARKERS: the mock has no feature flag and no stream limiter, so `409`/`503`
 * are otherwise unreachable from fixture state. Bodies are the producer's verbatim
 * module-level constants — the lowercase `companion_epub_*` codes are frozen contract and
 * consumers branch on them, so do not "fix" the casing.
 */
const COMPANION_EPUB_ERROR_MARKERS: Record<string, { status: number; body: ErrorEnvelope }> = {
  bk_companiondisabled: {
    status: 409,
    body: errorBody('companion_epub_disabled', 'Companion ebooks are disabled'),
  },
  bk_companionbusy: {
    status: 503,
    body: errorBody('companion_epub_busy', 'Too many concurrent companion ebook downloads'),
  },
};

/** `404` — EVERY other negative, without exception, so the endpoint can't be used as an
 *  existence oracle: no such book, book present but no companion, open failed. */
const COMPANION_EPUB_UNAVAILABLE = errorBody('companion_epub_unavailable', 'Companion ebook is unavailable');

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// In-memory book state with a time-based lifecycle. A freshly-added book advances
// searching → downloading → importing → imported over ~9s so the status poller can
// be observed driving a request to `available`.
// ---------------------------------------------------------------------------
interface BookState {
  id: string;
  asin: string;
  createdAtMs: number;
  preImported: boolean;
}

const STAGE_MS = { search: 2000, download: 4000, import: 3000 };

const bookByAsin = new Map<string, BookState>();
const bookById = new Map<string, BookState>();

/** Reset all mock state — for tests and clean restarts. */
export function resetMockNarratorrState(): void {
  bookByAsin.clear();
  bookById.clear();
}

function projectStatus(state: BookState, nowMs: number): BookStatus {
  if (state.preImported) return 'imported';
  const elapsed = nowMs - state.createdAtMs;
  if (elapsed < STAGE_MS.search) return 'searching';
  if (elapsed < STAGE_MS.search + STAGE_MS.download) return 'downloading';
  if (elapsed < STAGE_MS.search + STAGE_MS.download + STAGE_MS.import) return 'importing';
  return 'imported';
}

/**
 * Library cross-reference for a search result (narratorr #1537): a result is annotated
 * iff narratorr already has a book record for that ASIN (added in this session), with
 * the live projected status. Absent otherwise — exactly the contract the consumer codes
 * against. So: search → request → search again now shows "On the way" / "In library".
 *
 * `companionEbook` (#1961) is emitted with the key ALWAYS PRESENT whenever `library` is,
 * mirroring the producer where it is required-and-nullable inside the annotation: `null`
 * means "no companion ebook", never "old narratorr".
 */
function libraryFor(asin: string, nowMs: number): V1AudibleResult['library'] {
  const state = bookByAsin.get(asin);
  if (!state) return undefined;
  const status = projectStatus(state, nowMs);
  return { bookId: state.id, status, companionEbook: companionFor(asin, status) };
}

function toBook(state: BookState, nowMs: number): V1Book {
  const f = byAsin.get(state.asin)!;
  const status = projectStatus(state, nowMs);
  return {
    id: state.id,
    title: f.title,
    authors: f.authors,
    narrators: f.narrators,
    series: f.series ?? null,
    coverUrl: f.cover,
    asin: f.asin,
    status,
    // Same table as the search annotation, so the two surfaces agree by construction.
    companionEbook: companionFor(state.asin, status),
    createdAt: new Date(state.createdAtMs).toISOString(),
  };
}

function requireApiKey(request: Request): Response | null {
  if (!request.headers.get('x-api-key')) {
    return HttpResponse.json(errorBody('UNAUTHORIZED', 'Missing X-Api-Key'), { status: 401 });
  }
  return null;
}

/** MSW handlers implementing the vendored `/api/v1` contract against fixtures. */
export function narratorrV1Handlers(baseUrl: string = MOCK_BASE_URL): RequestHandler[] {
  return [
    // 1. Audible metadata search (v1.1, TO BUILD).
    http.get(`${baseUrl}/api/v1/metadata/search`, ({ request }) => {
      const unauth = requireApiKey(request);
      if (unauth) return unauth;
      const q = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase();
      if (!q) return HttpResponse.json(errorBody('BAD_REQUEST', 'q is required'), { status: 400 });
      const now = Date.now();
      const data: V1AudibleResult[] = CATALOG.filter((f) => {
        const hay = `${f.title} ${f.authors.map((a) => a.name).join(' ')} ${f.series?.name ?? ''}`.toLowerCase();
        return hay.includes(q);
      }).map((f) => {
        const library = libraryFor(f.asin, now);
        return library ? { ...f, library } : f;
      });
      return HttpResponse.json({ data, total: data.length });
    }),

    // 2. Add the book by ASIN (v1.1, TO BUILD). 201 new / 409 already-exists / 422 unhydratable.
    http.post(`${baseUrl}/api/v1/books`, async ({ request }) => {
      const unauth = requireApiKey(request);
      if (unauth) return unauth;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return HttpResponse.json(errorBody('BAD_REQUEST', 'invalid JSON'), { status: 400 });
      }
      const asin = (body as { asin?: unknown }).asin;
      if (typeof asin !== 'string' || !asin) {
        return HttpResponse.json(errorBody('BAD_REQUEST', 'asin is required'), { status: 400 });
      }
      // Add rejected at the gate (narratorr #1545) → 422, no book created. The code is one
      // of ADD_BOOK_ERROR_CODES; marker ASINs select a specific code, any other unknown
      // ASIN defaults to `asin_not_resolved`.
      if (!byAsin.has(asin)) {
        const code = ADD_ERROR_MARKERS[asin] ?? ADD_BOOK_ERROR_CODES.asinNotResolved;
        return HttpResponse.json(errorBody(code, `cannot add asin ${asin} (${code})`), { status: 422 });
      }

      // Already in the library → 409 with the existing id (NOT a duplicate, no re-grab).
      const existing = bookByAsin.get(asin);
      if (existing) {
        return HttpResponse.json(
          { ...errorBody('book_exists', 'A book with this ASIN already exists.'), existingId: existing.id },
          { status: 409 },
        );
      }

      const state: BookState = {
        id: publicId('bk'),
        asin,
        createdAtMs: Date.now(),
        preImported: PRE_IMPORTED.has(asin),
      };
      bookByAsin.set(asin, state);
      bookById.set(state.id, state);
      return HttpResponse.json(toBook(state, Date.now()), { status: 201 });
    }),

    // 3. Poll the book's lifecycle (SHIPPED, #1441).
    http.get(`${baseUrl}/api/v1/books/:id`, ({ request, params }) => {
      const unauth = requireApiKey(request);
      if (unauth) return unauth;
      const state = bookById.get(String(params.id));
      if (!state) return HttpResponse.json(errorBody('NOT_FOUND', 'book not found'), { status: 404 });
      return HttpResponse.json(toBook(state, Date.now()));
    }),

    // 4. Build-info probe (narratorr #1709). Returns narratorr's own version + build details
    //    under X-Api-Key auth — the System Information card's narratorr line reads `version`.
    http.get(`${baseUrl}/api/v1/system`, ({ request }) => {
      const unauth = requireApiKey(request);
      if (unauth) return unauth;
      return HttpResponse.json({
        version: 'v1.0.0',
        commit: 'abc1234',
        buildTime: '2026-06-01T00:00:00.000Z',
        nodeVersion: 'v24.10.0',
        os: 'Linux 6.8.0',
      });
    }),

    // 5. Capability probe (narratorr #1961). Its OWN endpoint, deliberately not a key on
    //    /api/v1/system: a pre-#1961 narratorr answers a plain 404, which is the only
    //    "unsupported" signal. Per-test variation (disabled / 404 / 401 / network error)
    //    is expressed with `server.use(...)` overrides — no toggle plumbing here.
    http.get(`${baseUrl}/api/v1/capabilities`, ({ request }) => {
      const unauth = requireApiKey(request);
      if (unauth) return unauth;
      return HttpResponse.json({ companionEpub: { enabled: true } });
    }),

    // 6. Companion-ebook byte stream (narratorr #1961).
    //
    //    ENVELOPE + HAPPY-PATH FIXTURE ONLY. This is explicitly NOT the vehicle for
    //    mid-body abort, truncation, or backpressure tests: MSW honors an abort only while
    //    a resolver is still pending and cannot interrupt an already-returned in-memory
    //    body, so such a test behaves identically for correct and broken code. Those need a
    //    real `node:http` server (see the body-stall test in narratorr-client.test.ts) and
    //    belong to the streaming-client / hardening stories.
    http.get(`${baseUrl}/api/v1/books/:publicId/companion-epub`, ({ request, params }) => {
      const unauth = requireApiKey(request);
      if (unauth) return unauth;

      // narratorr validates the path param (`z.string().trim().min(1)`) BEFORE the
      // resolver runs, so a whitespace-only segment is a plain 400 rather than the
      // companion 404. The code/message of that validation envelope is not load-bearing
      // for us — the consumer maps any upstream 400 onto its own 404.
      const id = decodeParam(String(params.publicId));
      if (id.trim() === '') {
        return HttpResponse.json(errorBody('BAD_REQUEST', 'publicId is required'), { status: 400 });
      }

      const marker = COMPANION_EPUB_ERROR_MARKERS[id];
      if (marker) return HttpResponse.json(marker.body, { status: marker.status });

      const state = bookById.get(id);
      const companion = state ? companionFor(state.asin, projectStatus(state, Date.now())) : null;
      if (!state || !companion) return HttpResponse.json(COMPANION_EPUB_UNAVAILABLE, { status: 404 });

      // The body's byte length EQUALS the advertised sizeBytes: a consumer that counts
      // bytes and compares against the annotation must never be tripped by the fixture.
      const filename = `${byAsin.get(state.asin)!.title.replace(/[^a-zA-Z0-9._-]/g, '-')}.epub`;
      return HttpResponse.arrayBuffer(new ArrayBuffer(companion.sizeBytes), {
        headers: {
          'Content-Type': 'application/epub+zip',
          'Content-Length': String(companion.sizeBytes),
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }),
  ];
}
