// One-shot 0.x -> 1.0 data import: copy users + requests from a pre-squash
// snapshot into a freshly-migrated flat-baseline DB. Run inside the app
// container from /app (bare @libsql/client import resolves there).
//
//   node import-legacy.js <snapshot.db> <target.db>
//
// Column mapping (source = old 0000 baseline, target = 1.0 flat baseline):
//   users:    + notify_on        -> '[]' (opt-in feature postdates the snapshot)
//   requests: - user_caused_failure (dropped in 0001; never producible)
//             + available_notified_at -> now for rows already 'available'
//               (the old 0003 backfill's semantics: their at-most-once send
//               happened under the old path; a null marker would make the
//               poller sweep treat them as owed), NULL otherwise.
// Resolve from the invoking directory (repo root locally, /app in the container).
const { createClient } = require(process.cwd() + '/node_modules/@libsql/client');

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node import-legacy.js <snapshot.db> <target.db>');
  process.exit(1);
}

const USER_COLS = [
  'id', 'public_id', 'auth_provider', 'auth_subject', 'username', 'password_hash',
  'email', 'thumb', 'role', 'status', 'request_quota_mode', 'request_quota_limit',
  'auto_approve', 'created_at',
];
const REQUEST_COLS = [
  'id', 'public_id', 'user_id', 'asin', 'title', 'author', 'narrator', 'cover_url',
  'status', 'narratorr_book_id', 'note', 'failure_reason', 'requested_at',
  'decided_at', 'decided_by',
];

(async () => {
  const source = createClient({ url: `file:${src}` });
  const target = createClient({ url: `file:${dst}` });
  const now = Math.floor(Date.now() / 1000);

  const existing = await target.execute('SELECT COUNT(*) AS n FROM users');
  if (Number(existing.rows[0].n) !== 0) {
    console.error(`target already has ${existing.rows[0].n} users — refusing to import into a non-empty DB`);
    process.exit(1);
  }

  const users = (await source.execute(`SELECT ${USER_COLS.join(', ')} FROM users ORDER BY id`)).rows;
  const requests = (await source.execute(`SELECT ${REQUEST_COLS.join(', ')} FROM requests ORDER BY id`)).rows;

  const stmts = [];
  for (const u of users) {
    stmts.push({
      sql: `INSERT INTO users (${USER_COLS.join(', ')}, notify_on) VALUES (${USER_COLS.map(() => '?').join(', ')}, '[]')`,
      args: USER_COLS.map((c) => u[c]),
    });
  }
  for (const r of requests) {
    stmts.push({
      sql: `INSERT INTO requests (${REQUEST_COLS.join(', ')}, available_notified_at) VALUES (${REQUEST_COLS.map(() => '?').join(', ')}, ?)`,
      args: [...REQUEST_COLS.map((c) => r[c]), r.status === 'available' ? now : null],
    });
  }

  // batch() runs as a single transaction — all-or-nothing.
  await target.batch(stmts, 'write');

  const u = await target.execute('SELECT COUNT(*) AS n FROM users');
  const rq = await target.execute('SELECT COUNT(*) AS n FROM requests');
  const settled = await target.execute(
    "SELECT COUNT(*) AS n FROM requests WHERE status = 'available' AND available_notified_at IS NOT NULL",
  );
  const owed = await target.execute(
    "SELECT COUNT(*) AS n FROM requests WHERE status = 'available' AND available_notified_at IS NULL",
  );
  const seq = await target.execute("SELECT name, seq FROM sqlite_sequence WHERE name IN ('users','requests')");
  console.log(
    JSON.stringify({
      imported: { users: Number(u.rows[0].n), requests: Number(rq.rows[0].n) },
      available_markers: { settled: Number(settled.rows[0].n), owed: Number(owed.rows[0].n) },
      sqlite_sequence: seq.rows,
    }),
  );
  source.close();
  target.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
