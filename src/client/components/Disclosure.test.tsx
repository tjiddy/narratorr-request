import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Disclosure } from './Disclosure';

/**
 * The shared disclosure primitive (#149). Its accessible RELATIONSHIP is the part that can't be a
 * pure function and the part that quietly rots: `aria-expanded` reflecting state, `aria-controls`
 * pointing at the panel this trigger actually toggles, and — the reason the panel id comes from
 * `useId` rather than a constant — two instances mounted at once staying independent. The account
 * modal and the ebook sheet can genuinely be open together, and a hard-coded id would make one
 * trigger claim to control the other's panel.
 *
 * Absence assertions are SYNCHRONOUS `queryBy*`.
 */

const STEP = 'Personal Document Settings';
const OTHER_STEP = 'Approved Personal Document E-mail List';

const triggers = () => screen.getAllByRole('button');

describe('Disclosure', () => {
  it('starts COLLAPSED with its panel absent from the DOM, not merely hidden', () => {
    render(
      <Disclosure label="Where is that?">
        <p>{STEP}</p>
      </Disclosure>,
    );

    const trigger = screen.getByRole('button', { name: 'Where is that?' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(STEP)).toBeNull();
  });

  it('reveals the panel it names, and collapses again', async () => {
    render(
      <Disclosure label="Where is that?">
        <p>{STEP}</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Where is that?' });

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panelId = trigger.getAttribute('aria-controls')!;
    expect(panelId).toBeTruthy();
    // The id is not a decoration: it resolves to the element actually holding the content.
    const panel = document.getElementById(panelId);
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent(STEP);

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(STEP)).toBeNull();
  });

  it('keeps two SIMULTANEOUS instances independent, each controlling its own panel', async () => {
    // The real pairing: the account modal's education and the ebook sheet's are both mounted while
    // the sheet is open over the modal. A shared, hard-coded panel id would pass every assertion
    // above and fail here.
    render(
      <>
        <Disclosure label="Where is that?">
          <p>{STEP}</p>
        </Disclosure>
        <Disclosure label="Where is that?">
          <p>{OTHER_STEP}</p>
        </Disclosure>
      </>,
    );
    const [first, second] = triggers() as [HTMLElement, HTMLElement];

    expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));

    await userEvent.click(first);

    // Only the first opened, and its `aria-controls` resolves to ITS panel — not the sibling's.
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(first.getAttribute('aria-controls')!)).toHaveTextContent(STEP);
    expect(screen.queryByText(OTHER_STEP)).toBeNull();

    await userEvent.click(second);

    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(first.getAttribute('aria-controls')!)).toHaveTextContent(STEP);
    expect(document.getElementById(second.getAttribute('aria-controls')!)).toHaveTextContent(OTHER_STEP);

    await userEvent.click(first);

    // Collapsing one leaves the other exactly as it was.
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText(STEP)).toBeNull();
    expect(screen.getByText(OTHER_STEP)).toBeInTheDocument();
  });
});
