import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToggleSwitch } from './ToggleSwitch';

// Ported with the component from narratorr (issue #193), minus the react-hook-form block —
// this repo's forms are hand-rolled useState, so the controlled-usage case replaces it.
// NOTE: rendered bare on purpose — the component owns its wrapping <label> (the visible track's
// click target). Call sites must NOT wrap it in another label; these tests mirror that contract.

/** The controlled shape every call site here uses (checked + onChange over useState). */
function ControlledHost() {
  const [on, setOn] = useState(false);
  return <ToggleSwitch id="controlled" checked={on} onChange={(e) => setOn(e.target.checked)} />;
}

describe('ToggleSwitch', () => {
  describe('rendering', () => {
    it('renders a hidden checkbox input with sr-only class and a styled div sibling with rounded-full', () => {
      render(<ToggleSwitch id="test" />);
      const input = screen.getByRole('checkbox');
      expect(input).toHaveClass('sr-only');
      expect(input.tagName).toBe('INPUT');
      expect(input).toHaveAttribute('type', 'checkbox');

      const sibling = input.nextElementSibling;
      expect(sibling).not.toBeNull();
      expect(sibling!.tagName).toBe('DIV');
      expect(sibling).toHaveClass('rounded-full');
    });

    it('wraps the input and track in its own label so bare call sites stay clickable', () => {
      render(<ToggleSwitch id="test" />);
      const input = screen.getByRole('checkbox');
      const wrapper = input.closest('label');
      expect(wrapper).not.toBeNull();
      expect(wrapper).toContainElement(input.nextElementSibling as HTMLElement);
      expect(wrapper).toHaveClass('cursor-pointer');
    });

    it('renders full size variant by default', () => {
      render(<ToggleSwitch id="test" />);
      const sibling = screen.getByRole('checkbox').nextElementSibling!;
      expect(sibling).toHaveClass('w-11', 'h-6');
    });

    it('renders compact size variant when size="compact"', () => {
      render(<ToggleSwitch id="test" size="compact" />);
      const sibling = screen.getByRole('checkbox').nextElementSibling!;
      expect(sibling).toHaveClass('w-9', 'h-5');
    });

    it('passes through id, name, aria-label attributes to the input element', () => {
      render(<ToggleSwitch id="my-toggle" name="myField" aria-label="My Toggle" />);
      const input = screen.getByRole('checkbox');
      expect(input).toHaveAttribute('id', 'my-toggle');
      expect(input).toHaveAttribute('name', 'myField');
      expect(input).toHaveAttribute('aria-label', 'My Toggle');
    });
  });

  describe('interaction', () => {
    it('toggling fires onChange via userEvent.click', async () => {
      const onChange = vi.fn();
      render(<ToggleSwitch id="test" onChange={onChange} />);
      const input = screen.getByRole('checkbox');
      await userEvent.click(input);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(input).toBeChecked();
    });

    it('clicking the visible TRACK toggles the checkbox (regression: bare toggles were click-dead)', async () => {
      // The sr-only input is invisible; the track div is what users actually click. Before the
      // component owned its label, a bare <ToggleSwitch /> rendered a track associated with
      // nothing — clicks did nothing.
      const onChange = vi.fn();
      render(<ToggleSwitch id="test" onChange={onChange} />);
      const input = screen.getByRole('checkbox');
      const track = input.nextElementSibling as HTMLElement;
      await userEvent.click(track);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(input).toBeChecked();
    });

    it('disabled state: input is disabled, click does not fire onChange', async () => {
      const onChange = vi.fn();
      render(<ToggleSwitch id="test" disabled onChange={onChange} />);
      const input = screen.getByRole('checkbox');
      expect(input).toBeDisabled();
      await userEvent.click(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('disabled state: clicking the visible track does nothing', async () => {
      const onChange = vi.fn();
      render(<ToggleSwitch id="test" disabled onChange={onChange} />);
      const input = screen.getByRole('checkbox');
      await userEvent.click(input.nextElementSibling as HTMLElement);
      expect(onChange).not.toHaveBeenCalled();
      expect(input).not.toBeChecked();
    });
  });

  describe('controlled usage (the shape the settings cards use)', () => {
    it('checked follows state through a click round-trip', async () => {
      render(<ControlledHost />);
      const input = screen.getByRole('checkbox');
      expect(input).not.toBeChecked();
      await userEvent.click(input);
      expect(input).toBeChecked();
      await userEvent.click(input);
      expect(input).not.toBeChecked();
    });
  });

  describe('boundary values', () => {
    it('renders without error when only type is provided via component default', () => {
      render(<ToggleSwitch />);
      expect(screen.getByRole('checkbox')).toBeInTheDocument();
    });

    it('checkbox is not checked when defaultChecked is false', () => {
      render(<ToggleSwitch defaultChecked={false} />);
      expect(screen.getByRole('checkbox')).not.toBeChecked();
    });

    it('checkbox is checked when defaultChecked is true', () => {
      render(<ToggleSwitch defaultChecked />);
      expect(screen.getByRole('checkbox')).toBeChecked();
    });
  });
});
