import { createContext, useContext } from 'react';

/**
 * The seam that lets a component deep in the tree OPEN the account modal (issue #149, AC10).
 *
 * `Layout` owns the modal's open state and renders the modal itself. The ebook sheet's State-B hint
 * ("add it in your account") has to reach that state from two different hosts — a search card and a
 * My Requests row — neither of which has any other reason to know the account modal exists.
 *
 * A CONTEXT rather than a prop is the deliberate choice of AC10's two options: threading an
 * `onOpenAccount` callback would mean adding a prop to `BookCard`, `RequestRow`, both pages AND the
 * sheet, purely as plumbing. `Layout` already wraps every route that can host the sheet, so one
 * provider covers both hosts with no change to either.
 *
 * A bare `<a href>` is NOT an option: navigating would unmount the sheet.
 *
 * `null` means "no provider above me" — the seam is unavailable and activating it is a no-op. That
 * happens only outside the app shell (an isolated component test), never in the running app.
 */
export const OpenAccountModalContext = createContext<(() => void) | null>(null);

/** The account-modal opener from the nearest {@link OpenAccountModalContext}, or `null`. */
export const useOpenAccountModal = (): (() => void) | null => useContext(OpenAccountModalContext);
