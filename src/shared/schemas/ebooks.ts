import { z } from 'zod';

/**
 * The Send-to-Kindle contract (issue #148). OUR OWN schema — not part of the vendored narratorr
 * `v1/` contract — so it MAY be `.strict()`; the no-`.strict()` rule applies only to `v1/`.
 *
 * Every ADMITTED attempt answers `200 { outcome }`, including the failures: the central error
 * handler owns the `{ error: { code, message } }` envelope and would flatten a typed outcome into
 * a code string, and the client must branch on ONE field. The only non-200 answers are the
 * business refusals, the pre-handler parser errors, and the two enumerated infrastructure 500s.
 */
export const EBOOK_SEND_OUTCOMES = [
  'sent',
  'no_kindle_address',
  'no_sender',
  'unavailable',
  'too_large',
  'rate_limited',
  'quota_exhausted',
  'failed',
  'indeterminate',
] as const;
export const ebookSendOutcomeSchema = z.enum(EBOOK_SEND_OUTCOMES);
export type EbookSendOutcome = (typeof EBOOK_SEND_OUTCOMES)[number];

/** The whole response body. `.strict()` so a stray field is a contract break, not a silent extra. */
export const ebookSendResultSchema = z.object({ outcome: ebookSendOutcomeSchema }).strict();
export type EbookSendResult = z.infer<typeof ebookSendResultSchema>;

/**
 * The audit row's lifecycle. `started` is the RESERVATION (the admission mechanism itself); the
 * other three are the terminal statuses exactly one of which is written per admitted attempt.
 * Deliberately a DIFFERENT set from {@link EBOOK_SEND_OUTCOMES}: a refusal that never reserved
 * (`no_sender`, `too_large`, …) has no row at all.
 */
export const KINDLE_SEND_ATTEMPT_STATUSES = ['started', 'sent', 'failed', 'indeterminate'] as const;
export type KindleSendAttemptStatus = (typeof KINDLE_SEND_ATTEMPT_STATUSES)[number];
/** The terminal subset — what a finalization may ever write. */
export const KINDLE_SEND_TERMINAL_STATUSES = ['sent', 'failed', 'indeterminate'] as const;
export type KindleSendTerminalStatus = (typeof KINDLE_SEND_TERMINAL_STATUSES)[number];

/**
 * SAFE failure codes — the audit row's only free-text field besides the book id. Never an SMTP
 * response string, never an upstream message, never a filename. Frozen: each code's producing
 * conditions are enumerated in the spec (AC45) and a test asserts the correspondence in both
 * directions, so a code with no producer (or a producer minting an unlisted code) fails.
 */
export const KINDLE_SEND_FAILURE_CODES = [
  'upstream_unavailable',
  'oversize',
  'size_mismatch',
  'smtp_rejected',
  'smtp_error',
  'attempt_timeout',
  'lease_expired',
] as const;
export type KindleSendFailureCode = (typeof KINDLE_SEND_FAILURE_CODES)[number];
