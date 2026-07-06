import { describe, it, expect } from 'vitest';
import type { UserDto } from '@shared/schemas/user';
import type { ListEnvelope } from '@shared/schemas/v1/common';
import { selectUserDetailState } from './selectUserDetailState';

// Minimal fixture — only `publicId` matters for the branch decision; the rest is
// filler to satisfy the type.
const user = (publicId: string): UserDto => ({
  publicId,
  username: publicId,
  authProvider: 'local',
  email: null,
  thumb: null,
  role: 'user',
  status: 'active',
  requestQuota: { mode: 'inherit' },
  autoApprove: false,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const envelope = (users: UserDto[]): ListEnvelope<UserDto> => ({ data: users, total: users.length });

describe('selectUserDetailState', () => {
  it("loading → 'loading'", () => {
    const state = selectUserDetailState({ isLoading: true, error: null, data: undefined }, 'a');
    expect(state.kind).toBe('loading');
  });

  it("error set → 'error', even with a stale data list present", () => {
    const state = selectUserDetailState(
      { isLoading: false, error: new Error('boom'), data: envelope([user('a')]) },
      'a',
    );
    // Must not fall through to 'found' just because the matching row is still cached.
    expect(state.kind).toBe('error');
  });

  it("fetch succeeded, publicId absent → 'not-found'", () => {
    const state = selectUserDetailState(
      { isLoading: false, error: null, data: envelope([user('a'), user('b')]) },
      'missing',
    );
    expect(state.kind).toBe('not-found');
  });

  it("fetch succeeded, publicId present → 'found' with the matched row", () => {
    const target = user('a');
    const state = selectUserDetailState(
      { isLoading: false, error: null, data: envelope([target, user('b')]) },
      'a',
    );
    expect(state).toEqual({ kind: 'found', user: target });
  });

  it("succeeded with an empty list → 'not-found'", () => {
    const state = selectUserDetailState({ isLoading: false, error: null, data: envelope([]) }, 'a');
    expect(state.kind).toBe('not-found');
  });

  it("undefined publicId (no route param) → 'not-found' when the fetch succeeded", () => {
    const state = selectUserDetailState(
      { isLoading: false, error: null, data: envelope([user('a')]) },
      undefined,
    );
    expect(state.kind).toBe('not-found');
  });
});
