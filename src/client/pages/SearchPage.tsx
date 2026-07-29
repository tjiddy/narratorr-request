import { useMemo, useState, type FormEvent } from 'react';
import type { RequestStatus } from '@shared/schemas/request';
import { useSearch, useMyRequests, useMe, useFeatures } from '../hooks';
import { ebooksVisible } from '../features';
import { BookCard } from '../components/BookCard';
import { EmptyState } from '../components/EmptyState';
import { SearchIcon } from '../components/icons';
import { Button } from '../components/Button';
import { QuotaMeter } from '../components/QuotaMeter';
import { ApiError } from '../api';

export function SearchPage() {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');

  const search = useSearch(q);
  const mine = useMyRequests();
  // Read through the pure gate, never off `.data`: a loading or errored /api/features renders the
  // feature as OFF (fail-safe) rather than flashing an affordance that may not exist.
  const ebooksEnabled = ebooksVisible(useFeatures(useMe().data));

  const statusByAsin = useMemo(() => {
    const map = new Map<string, RequestStatus>();
    for (const r of mine.data?.data ?? []) map.set(r.asin, r.status);
    return map;
  }, [mine.data]);

  // Search on submit only — each query round-trips to narratorr → Audnexus, so we
  // never fire on keystroke (that hammered the metadata provider and tripped rate limits).
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
  };

  return (
    <div>
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Request audiobooks
          </h1>
          <QuotaMeter />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Search the catalog and request what you want to listen to.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          autoFocus
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search by title, author, or series…"
          className="w-full rounded-xl border border-border bg-card px-4 py-3 text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <Button type="submit" variant="primary" icon={SearchIcon} loading={search.isFetching} disabled={input.trim() === ''}>
          Search
        </Button>
      </form>

      <div className="mt-6">
        {q.trim() === '' && <p className="text-sm text-muted-foreground/70">Search for a book to request.</p>}
        {search.isFetching && <p className="text-sm text-muted-foreground/70">Searching…</p>}
        {search.error && (
          <p className="text-sm text-destructive">
            {search.error instanceof ApiError ? search.error.message : 'Search failed'}
          </p>
        )}
        {search.data && search.data.data.length === 0 && !search.isFetching && (
          <EmptyState
            icon={SearchIcon}
            title="No results"
            subtitle={`Nothing matched “${q}”. Try a different title, author, or series.`}
          />
        )}
        {search.data && search.data.data.length > 0 && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {search.data.data.map((r) => (
              <BookCard
                key={r.asin}
                result={r}
                requestedStatus={statusByAsin.get(r.asin)}
                ebooksEnabled={ebooksEnabled}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
