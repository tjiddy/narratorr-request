import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { UserDto } from '@shared/schemas/user';
import { DEFAULT_LIMIT } from '@shared/schemas/v1/common';
import { useMe, useUsers, useUpdateUser, useUserRequests } from '../hooks';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { InboxIcon } from '../components/icons';
import { requestFailureReason } from '../components/request-failure';
import { PagedListFooter } from '../components/PagedListFooter';
import { nextLimit } from '../components/paging';
import {
  initRequestQuota,
  buildRequestQuota,
  isRequestQuotaValid,
  isRequestQuotaDirty,
  type RequestQuotaState,
} from './parseQuota';
import { selectUserDetailState } from './selectUserDetailState';
import type { RequestQuotaMode } from '@shared/schemas/user';

type UpdateUser = ReturnType<typeof useUpdateUser>;
type UserRequests = ReturnType<typeof useUserRequests>;

export function UserDetailPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const users = useUsers();
  const state = selectUserDetailState(users, publicId);

  if (state.kind === 'loading') return <p className="text-sm text-muted-foreground/70">Loading…</p>;
  if (state.kind === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/users" className="text-sm text-muted-foreground hover:text-foreground">← Users</Link>
        <p className="text-sm text-destructive">Could not load user.</p>
      </div>
    );
  }
  if (state.kind === 'not-found') {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/users" className="text-sm text-muted-foreground hover:text-foreground">← Users</Link>
        <EmptyState icon={InboxIcon} title="User not found" subtitle="They may no longer exist." />
      </div>
    );
  }
  // key on publicId so the editor state resets when navigating between users.
  return <UserDetail key={state.user.publicId} user={state.user} />;
}

function UserDetail({ user }: { user: UserDto }) {
  const me = useMe();
  const update = useUpdateUser();
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const requests = useUserRequests(user.publicId, limit);

  const isSelf = me.data?.publicId === user.publicId;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/users" className="text-sm text-muted-foreground hover:text-foreground">← Users</Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">
          {user.username}
          {isSelf && <span className="ml-2 text-sm font-normal text-muted-foreground/70">(you)</span>}
        </h1>
        {user.email && <p className="text-sm text-muted-foreground">{user.email}</p>}
      </div>

      <div className="glass-card flex flex-col gap-4 rounded-xl p-4">
        <StatusControl user={user} isSelf={isSelf} update={update} />
        <RoleControl user={user} isSelf={isSelf} update={update} />
        <AutoApproveControl user={user} update={update} />
        <QuotaControl user={user} update={update} />
      </div>

      <UserRequestsList
        requests={requests}
        username={user.username}
        limit={limit}
        onLoadMore={() => setLimit(nextLimit)}
      />
    </div>
  );
}

function StatusControl({ user, isSelf, update }: { user: UserDto; isSelf: boolean; update: UpdateUser }) {
  const saving = update.isPending && update.variables?.patch.status !== undefined;
  const statusVariant = user.status === 'active' ? 'success' : user.status === 'pending' ? 'warning' : 'danger';
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="font-medium">Status</p>
        <p className="text-xs text-muted-foreground/70">Approve to let them request; reject to deny access.</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge variant={statusVariant}>{user.status[0]?.toUpperCase() + user.status.slice(1)}</Badge>
        {!isSelf && user.status !== 'active' && (
          <Button
            variant="success"
            size="sm"
            loading={saving}
            onClick={() => update.mutate({ publicId: user.publicId, patch: { status: 'active' } })}
          >
            Approve
          </Button>
        )}
        {!isSelf && user.status === 'active' && (
          <Button
            variant="secondary"
            size="sm"
            loading={saving}
            onClick={() => update.mutate({ publicId: user.publicId, patch: { status: 'rejected' } })}
          >
            Reject
          </Button>
        )}
      </div>
    </div>
  );
}

function RoleControl({ user, isSelf, update }: { user: UserDto; isSelf: boolean; update: UpdateUser }) {
  const isAdmin = user.role === 'admin';
  const saving = update.isPending && update.variables?.patch.role !== undefined;
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-4">
      <div>
        <p className="font-medium">Role</p>
        <p className="text-xs text-muted-foreground/70">Admins approve requests and manage users.</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge variant={isAdmin ? 'info' : 'muted'}>{isAdmin ? 'Admin' : 'User'}</Badge>
        <Button
          variant={isAdmin ? 'secondary' : 'success'}
          size="sm"
          disabled={isSelf}
          loading={saving}
          title={isSelf ? "You can't change your own role" : undefined}
          onClick={() => update.mutate({ publicId: user.publicId, patch: { role: isAdmin ? 'user' : 'admin' } })}
        >
          {isAdmin ? 'Demote to user' : 'Make admin'}
        </Button>
      </div>
    </div>
  );
}

function AutoApproveControl({ user, update }: { user: UserDto; update: UpdateUser }) {
  const isAdmin = user.role === 'admin';
  return (
    <label className="flex items-center justify-between gap-4 border-t border-border/50 pt-4">
      <div>
        <p className="font-medium">Auto-approve requests</p>
        <p className="text-xs text-muted-foreground/70">
          Skip the pending queue — still counts against their quota. Admins always auto-approve.
        </p>
      </div>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-primary disabled:opacity-50"
        checked={isAdmin || user.autoApprove}
        disabled={isAdmin}
        onChange={(e) => update.mutate({ publicId: user.publicId, patch: { autoApprove: e.target.checked } })}
      />
    </label>
  );
}

// Mode-first per-user quota override: `Use app default` (inherit) | `Unlimited` | `Custom limit`
// (a positive cap) | `Blocked` (a hard admin block, distinct from a cap of 0). Custom reveals the
// positive-int input. Pure seed/validate/patch logic lives in parseQuota.ts. Admins are always
// unlimited, so the control is disabled for them.
const QUOTA_MODE_LABELS: Record<RequestQuotaMode, string> = {
  inherit: 'Use app default',
  unlimited: 'Unlimited',
  limited: 'Custom limit',
  blocked: 'Blocked',
};

function QuotaControl({ user, update }: { user: UserDto; update: UpdateUser }) {
  const isAdmin = user.role === 'admin';
  const saving = update.isPending && update.variables?.patch.requestQuota !== undefined;
  const initial = initRequestQuota(user.requestQuota);
  const [quota, setQuota] = useState<RequestQuotaState>(initial);
  const valid = isRequestQuotaValid(quota);
  const dirty = isRequestQuotaDirty(quota, initial);

  const saveQuota = () => {
    const value = buildRequestQuota(quota);
    if (value === undefined) return; // invalid Custom limit → no-op
    update.mutate({ publicId: user.publicId, patch: { requestQuota: value } });
  };

  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-4">
      <div>
        <p className="font-medium">Request quota</p>
        <p className="text-xs text-muted-foreground/70">
          Override the app default for this user. Custom caps open requests in the rolling window;
          Blocked stops them entirely. Admins are always unlimited.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <select
          value={isAdmin ? 'unlimited' : quota.mode}
          disabled={isAdmin}
          onChange={(e) => setQuota((s) => ({ ...s, mode: e.target.value as RequestQuotaMode }))}
          aria-label="Request quota mode"
          className="rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        >
          {(Object.keys(QUOTA_MODE_LABELS) as RequestQuotaMode[]).map((m) => (
            <option key={m} value={m}>
              {QUOTA_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        {!isAdmin && quota.mode === 'limited' && (
          <input
            type="text"
            inputMode="numeric"
            value={quota.limit}
            placeholder="10"
            aria-label="Custom request limit"
            onChange={(e) => setQuota((s) => ({ ...s, limit: e.target.value }))}
            className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
        <Button variant="secondary" size="sm" disabled={isAdmin || !valid || !dirty} loading={saving} onClick={saveQuota}>
          Save
        </Button>
      </div>
    </div>
  );
}

function UserRequestsList({
  requests,
  username,
  limit,
  onLoadMore,
}: {
  requests: UserRequests;
  username: string;
  limit: number;
  onLoadMore: () => void;
}) {
  return (
    <div>
      <h2 className="mb-3 font-display text-lg font-semibold">Requests</h2>
      {requests.isLoading && <p className="text-sm text-muted-foreground/70">Loading…</p>}
      {requests.error && <p className="text-sm text-destructive">Could not load requests.</p>}
      {requests.data && requests.data.data.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="No requests"
          subtitle={`${username} hasn’t requested anything yet.`}
        />
      )}
      {requests.data && requests.data.data.length > 0 && (
        <>
        <ul className="flex flex-col gap-2">
          {requests.data.data.map((r) => {
            const failureReason = requestFailureReason(r);
            return (
              <li key={r.publicId} className="glass-card flex items-center gap-3 rounded-lg p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.title}</p>
                  {r.author && <p className="truncate text-xs text-muted-foreground">{r.author}</p>}
                  {failureReason && (
                    <p className="truncate text-xs text-destructive">
                      <span className="text-destructive/70">Failed: </span>
                      {failureReason}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground/70">
                  {new Date(r.requestedAt).toLocaleDateString()}
                </span>
                <StatusBadge status={r.status} />
              </li>
            );
          })}
        </ul>
        <PagedListFooter
          loaded={requests.data.data.length}
          total={requests.data.total}
          limit={limit}
          isFetching={requests.isFetching}
          onLoadMore={onLoadMore}
        />
        </>
      )}
    </div>
  );
}
