# Companion ebooks — manual two-app smoke checklist

Release verification for the companion-ebook feature (Get eBook + Send to Kindle) against a **real
narratorr**, a **real SMTP relay** and a **real browser**.

The automated cross-app suite (`src/server/integration/*.integration.test.ts`) already proves the
whole path against fakes — capability discovery, the search annotation, byte-exact proxying,
truncation, upstream refusals, SMTP authentication, the audit row and the leak sweep. Run this
checklist for the three things no fake can stand in for:

- **A real Amazon allowlist.** Amazon's Approved Personal Document E-mail List is per-sender;
  nothing in CI can tell you whether *your* From address is on it.
- **A real relay.** Rate limits, size limits, greylisting, SPF/DKIM/DMARC and TLS negotiation are
  the relay's behavior, not ours.
- **A real browser download.** Content-Disposition handling, the Save-As dialog and whether the
  saved file actually opens in an EPUB reader.

Everything else below is belt-and-braces on a green `pnpm verify`.

## 0. Prerequisites

- A narratorr instance on the **companion-ebook contract** (narratorr #1961): it must serve
  `GET /api/v1/capabilities` and have at least one imported book with a companion EPUB paired.
- An `/api/v1` API key for that instance.
- An email (SMTP) notifier you can send from, whose From address is on the target Kindle's
  **Approved Personal Document E-mail List**.
- A Kindle device address (`…@kindle.com`) for the account you will check.
- Shell access to the deployment (for step 7).

## 1. Point Settings at the real narratorr

1. Sign in as an admin → **Settings → narratorr**.
2. Enter the narratorr **Server URL** and **API key**, save, then hit **Test**.
   - ✅ The test succeeds. (It pings a bogus book id and treats the structured `404` as proof the
     URL is reachable *and* the key authenticated.)
3. Turn **Companion ebooks** on.

## 2. Confirm `/api/features` flips

With the admin (or any active) session, in a browser tab or via `curl` with the session cookie:

```bash
curl -s --cookie "nreq_session=<your session cookie>" https://<your-host>/api/features
```

- ✅ `{"ebooksEnabled":true,"kindleDeliveryAvailable":…,"kindleSenderEmail":…}`.
- ✅ `ebooksEnabled` is `false` while **either** the admin toggle is off **or** narratorr does not
  advertise the capability — flip the toggle off and back on to see both states.
- ✅ `kindleSenderEmail` is `null` until step 5 selects a stable Kindle sender.

## 3. Find a book with a companion in search

1. Search for a title narratorr has imported **with** a companion EPUB.
2. ✅ The result shows the library annotation, and a **Get eBook** affordance appears.
3. ✅ A book with no companion shows no affordance at all (not a disabled one).

## 4. Download it in the browser and open the file

1. Click **Get eBook** (or open **My Requests** and use the row's action sheet).
2. ✅ The browser saves a file named after the **title**, ending in `.epub` — never a narratorr
   filename, never a path.
3. ✅ The saved file opens in an EPUB reader (Calibre, Apple Books, Thorium…) and is the right book.
4. ✅ Nothing in the download URL, the response headers or the page reveals the narratorr host, its
   API key or a filesystem path. (DevTools → Network → the `/api/ebooks/…/download` request.)

## 5. Save a Kindle address and select the sender

1. **Settings → Notifications**: create (or pick) the **email (SMTP)** notifier whose From is on the
   Amazon allowlist, then select it as the **Kindle sender**.
   - ✅ It is accepted only if its From parses to exactly one valid mailbox.
   - ✅ `GET /api/features` now reports `kindleDeliveryAvailable: true` and that mailbox as
     `kindleSenderEmail`.
2. As the **requesting user**, open the account modal and save the Kindle device address
   (`…@kindle.com`).
   - ✅ It round-trips after a reload.
   - ✅ It is visible **only** to that user — an admin looking at the user list never sees it.

## 6. Send to Kindle, and confirm arrival

1. From the book's action sheet choose **Send to Kindle**.
2. ✅ The UI reports `sent`.
3. ✅ The document appears in the Kindle library (allow a few minutes; Amazon's ingestion is
   asynchronous).
4. ✅ Re-sending the same book within a minute returns the **same** outcome and does **not** deliver
   a second copy.
5. Worth doing once per release: temporarily remove the sender From from the Amazon allowlist (or
   use an address that is not on it) and confirm the send reports a failure rather than silently
   claiming success.

## 7. Confirm the audit row

`kindle_sends` **is** the admission mechanism, not a log beside one, and it is deliberately
redacted: no recipient address, no sender address, no filename, no SMTP response text, no content
bytes. There is no audit UI or API — inspect the database directly, **read-only**.

Find the database file first: `DATABASE_PATH` (Docker Compose sets `/data/narratorr-requests.db`;
a bare `pnpm start` defaults to `./narratorr-requests.db` under the app root).

```bash
# Docker Compose (adjust the service name if you renamed it).
docker compose exec narratorr-requests \
  sqlite3 "file:/data/narratorr-requests.db?mode=ro" -header -column \
  "SELECT id, user_id, book_id, status, byte_count, failure_code,
          datetime(started_at/1000, 'unixepoch')   AS started_utc,
          datetime(finalized_at/1000, 'unixepoch') AS finalized_utc
     FROM kindle_sends
    ORDER BY id DESC
    LIMIT 5;"
```

> `?mode=ro` opens the file read-only, so an inspection can never write to a live database. If the
> image has no `sqlite3`, copy the file out first (`docker compose cp
> narratorr-requests:/data/narratorr-requests.db ./audit.db`) and run the same queries against the
> copy.

- ✅ Exactly **one** row for your `(user, book)` send, `status = 'sent'`.
- ✅ `finalized_at` is non-null and `failure_code` is empty.
- ✅ `byte_count` equals the companion's advertised size.

Then check the redaction — the whole row, and the table's whole column list:

```bash
sqlite3 "file:/data/narratorr-requests.db?mode=ro" ".mode line" \
  "SELECT * FROM kindle_sends ORDER BY id DESC LIMIT 1;"

sqlite3 "file:/data/narratorr-requests.db?mode=ro" "PRAGMA table_info(kindle_sends);"
```

- ✅ The columns are exactly: `id`, `user_id`, `book_id`, `status`, `byte_count`, `failure_code`,
  `started_at`, `finalized_at`. Anything else is a redaction regression.
- ✅ The printed row contains **no** email address, **no** `.epub` filename, **no** SMTP response
  text and no payload bytes. A quick belt-and-braces sweep:

```bash
sqlite3 "file:/data/narratorr-requests.db?mode=ro" \
  "SELECT count(*) AS suspicious
     FROM kindle_sends
    WHERE book_id LIKE '%@%' OR book_id LIKE '%.epub%'
       OR ifnull(failure_code,'') LIKE '%@%';"
```

- ✅ `suspicious` is `0`.

Finally, confirm the application log is clean for the same window:

```bash
docker compose logs --since 15m narratorr-requests | grep -iE '@kindle\.com|<your api key>|/api/v1'
```

- ✅ No matches. Kindle-send log lines carry the user's public id and the book id only.

## 8. Old-narratorr regression check (optional but cheap)

Point Settings at a narratorr **without** the capability endpoint (or block
`/api/v1/capabilities`).

- ✅ `GET /api/features` reports `ebooksEnabled: false`.
- ✅ The Get eBook / Send to Kindle affordances disappear.
- ✅ Calling the routes directly is refused (`403 EBOOKS_DISABLED`) — and narratorr sees **no**
  companion-EPUB request at all.
