// The app's ONE byte-humanization decision (1024-based units, whole bytes below 1 KB, one
// decimal above). Both consumers layer their own INPUT POLICY on top and share this core, so the
// two can never drift apart on what "1.5 KB" means:
//   - System Information (`pages/system-info.ts`) maps a `null` stat to "unavailable";
//   - the companion-ebook sheet (`components/ebook-sheet.ts`) maps an invalid `sizeBytes` to no
//     size chip at all, and rounds a fractional contract value to the nearest byte first.

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * Humanize a FINITE, NON-NEGATIVE byte count: `0` → "0 B", `1023` → "1023 B", `1024` → "1 KB",
 * `1536` → "1.5 KB". Callers own validation — this function assumes a whole, valid count and has
 * no "unknown" answer of its own.
 */
export function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}
