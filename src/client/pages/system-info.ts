import type { SystemInfoDto } from '@shared/schemas/system';
import { humanizeBytes } from '../format-bytes';

// Pure display logic for the System Information card. Per the repo's frontend-testing
// convention, the format/decision logic lives here (co-located .test.ts) rather than inline
// JSX — the card component just renders the strings these return.

/**
 * Humanize a raw byte count into a label: `0` → "0 B", `1536` → "1.5 KB", and `null`
 * (any stat failure / non-regular-file path) → "unavailable". This card's INPUT POLICY over the
 * shared {@link humanizeBytes} core, which the companion-ebook size chip also builds on.
 */
export function formatDatabaseSize(bytes: number | null): string {
  return bytes === null ? 'unavailable' : humanizeBytes(bytes);
}

/**
 * Compose the narratorr line from its `{ state, version }`:
 * - connected     → "v1.0.0 · connected" (or bare "connected" if version is somehow absent)
 * - not_configured → "not configured"
 * - unreachable / unavailable → "unreachable"
 */
export function formatNarratorrLine(narratorr: SystemInfoDto['narratorr']): string {
  switch (narratorr.state) {
    case 'connected':
      return narratorr.version ? `${narratorr.version} · connected` : 'connected';
    case 'not_configured':
      return 'not configured';
    default:
      return 'unreachable';
  }
}
