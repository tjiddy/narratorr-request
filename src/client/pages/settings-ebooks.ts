import type { ConnectorSettingsDto, UpdateConnectorSettingsBody } from '@shared/schemas/connectors';

// Companion-ebook toggle card form state + decision logic (issue #144). Pulled out of the
// component as pure functions — matching settings-narratorr.ts / settings-default-quota.ts — so
// the seed, the dirty check and (above all) the built payload are unit-tested without a DOM.

/** Seed the toggle from the saved DTO. */
export const initEbooksEnabled = (dto: Pick<ConnectorSettingsDto, 'ebooksEnabled'>): boolean => dto.ebooksEnabled;

/** Dirty when the draft differs from the saved baseline — a boolean has no invalid state. */
export const isEbooksDirty = (draft: boolean, initial: boolean): boolean => draft !== initial;

/**
 * The per-card PUT payload: ONLY `ebooksEnabled`, so the omit-to-keep body leaves the narratorr
 * connection, public URL, quota and Kindle sender untouched — and, critically, does not carry a
 * `narratorr` key, which is what would make the server retire its cached capability.
 *
 * The draft is sent VERBATIM, including an explicit `false`. Dropping a falsy value here (a
 * `...(draft && { ebooksEnabled: draft })` spread) would make the toggle impossible to turn off:
 * the omitted field means "keep" on the server.
 */
export const buildEbooksEnabled = (draft: boolean): UpdateConnectorSettingsBody => ({ ebooksEnabled: draft });
