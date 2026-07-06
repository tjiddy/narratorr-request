import type { UserDto } from '@shared/schemas/user';
import type { ListEnvelope } from '@shared/schemas/v1/common';

// Branch-decision logic for UserDetailPage, pulled out so the loading/error/not-found/found
// selection is unit-testable without a DOM (vitest node env), matching the helper pattern in
// parseQuota.ts / sortUsersByStatus.ts.
//
// The order is load-bearing: a rejected users fetch must resolve to `error`, NOT `not-found` —
// rendering "User not found" for a transient fetch failure is a false statement (the bug this
// fixes). So we gate isLoading → error → !user, and only then treat a genuinely-absent publicId
// as not-found.

/** The subset of a TanStack `useQuery` result this decision consumes. */
export interface UserDetailQuery {
  isLoading: boolean;
  error: unknown;
  data: ListEnvelope<UserDto> | undefined;
}

export type UserDetailState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'not-found' }
  | { kind: 'found'; user: UserDto };

export function selectUserDetailState(query: UserDetailQuery, publicId: string | undefined): UserDetailState {
  if (query.isLoading) return { kind: 'loading' };
  if (query.error) return { kind: 'error' };
  const user = query.data?.data.find((u) => u.publicId === publicId);
  if (!user) return { kind: 'not-found' };
  return { kind: 'found', user };
}
