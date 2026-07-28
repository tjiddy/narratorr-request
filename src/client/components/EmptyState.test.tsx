import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REQUEST_STATUSES } from '@shared/schemas/request';
import { EmptyState } from './EmptyState';
import { Button } from './Button';
import { InboxIcon } from './icons';

/**
 * Exemplar for the jsdom `client` vitest project (see vitest.config.ts). It is deliberately a
 * render/branch/interaction test — the kind of DOM-only behavior that can't be a pure helper.
 * Payload/parse/decision logic still belongs in pure `.test.ts` helpers.
 */
describe('EmptyState', () => {
  it('renders the title and subtitle text', () => {
    render(<EmptyState title="No requests yet" subtitle="Search for a book to get started." />);

    expect(screen.getByRole('heading', { name: 'No requests yet' })).toBeInTheDocument();
    expect(screen.getByText('Search for a book to get started.')).toBeInTheDocument();
  });

  // Paired with the test above: both render the same title and both use a singular getByText,
  // so if `afterEach(cleanup)` ever falls out of src/client/test/setup.ts this one fails with
  // "Found multiple elements". It is a live regression test for the setup file.
  it('leaves no leftover DOM between tests', () => {
    render(<EmptyState title="No requests yet" subtitle="A second render of the same title." />);

    expect(screen.getByText('No requests yet')).toBeInTheDocument();
  });

  it('omits the icon block when no icon is passed', () => {
    const { container } = render(<EmptyState title="No requests" subtitle="Nothing here." />);

    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the icon when one is passed', () => {
    const { container } = render(
      <EmptyState icon={InboxIcon} title="No requests" subtitle="Nothing here." />,
    );

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('omits the children wrapper when there are no children', () => {
    render(<EmptyState title="No requests" subtitle="Nothing here." />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders children when provided', () => {
    render(
      <EmptyState title="No requests" subtitle="Nothing here.">
        <Button variant="primary">Retry</Button>
      </EmptyState>,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('applies data-testid when provided', () => {
    render(<EmptyState title="No requests" subtitle="Nothing here." data-testid="empty-requests" />);

    expect(screen.getByTestId('empty-requests')).toBeInTheDocument();
  });

  // The prop is omitted entirely rather than passed as undefined — exactOptionalPropertyTypes
  // rejects `data-testid={undefined}`.
  it('renders no test id when the prop is omitted', () => {
    render(<EmptyState title="No requests" subtitle="Nothing here." />);

    expect(screen.queryByTestId('empty-requests')).not.toBeInTheDocument();
  });

  it('forwards clicks on a rendered child control to its handler', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState title="No requests" subtitle="Nothing here.">
        <Button variant="primary" onClick={onClick}>
          Retry
        </Button>
      </EmptyState>,
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // A runtime (not type-only) @shared import proves the jsdom project inherited the root
  // resolve.alias through `extends: true`; without it this file fails to resolve.
  it('renders text derived from a shared schema value', () => {
    render(
      <EmptyState title="No requests" subtitle={`Statuses: ${REQUEST_STATUSES.join(', ')}`} />,
    );

    expect(screen.getByText(/pending/)).toBeInTheDocument();
  });
});
