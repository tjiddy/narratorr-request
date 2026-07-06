import { Link } from 'react-router-dom';
import type { UserDto } from '@shared/schemas/user';
import { useMe, useUsers, useUpdateUser } from '../hooks';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { InboxIcon } from '../components/icons';
import { sortUsersByStatus } from './sortUsersByStatus';

type UpdateUser = ReturnType<typeof useUpdateUser>;
type UserPatch = Parameters<UpdateUser['mutate']>[0]['patch'];

export function UsersPage() {
  const me = useMe();
  const users = useUsers();
  const update = useUpdateUser();

  const rows = users.data ? sortUsersByStatus(users.data.data) : [];
  const pendingCount = rows.filter((u) => u.status === 'pending').length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Approve who can request, manage roles, and adjust quota or auto-approve. You can&rsquo;t change your own role.
        </p>
        {pendingCount > 0 && (
          <p className="mt-2 text-sm text-amber-400">
            {pendingCount} {pendingCount === 1 ? 'user is' : 'users are'} awaiting approval.
          </p>
        )}
      </div>

      {users.isLoading && <p className="text-sm text-muted-foreground/70">Loading…</p>}
      {users.error && <p className="text-sm text-destructive">Could not load users.</p>}
      {users.data && rows.length === 0 && (
        <EmptyState icon={InboxIcon} title="No users yet" subtitle="Users appear here after they first sign in." />
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {rows.map((u) => (
            <UserRow key={u.publicId} user={u} currentUserId={me.data?.publicId} update={update} />
          ))}
        </ul>
      )}
    </div>
  );
}

function UserRow({ user, currentUserId, update }: { user: UserDto; currentUserId: string | undefined; update: UpdateUser }) {
  const isSelf = currentUserId === user.publicId;
  const isAdmin = user.role === 'admin';
  const busy = update.isPending && update.variables?.publicId === user.publicId;
  const set = (patch: UserPatch) => update.mutate({ publicId: user.publicId, patch });

  return (
    <li className="glass-card flex items-center gap-3 rounded-xl p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          <Link to={`/users/${user.publicId}`} className="underline-offset-4 hover:text-primary hover:underline">
            {user.username}
          </Link>
          {isSelf && <span className="ml-1 text-xs text-muted-foreground/70">(you)</span>}
          <span className="ml-2 text-xs font-normal text-muted-foreground/60">{user.authProvider}</span>
        </p>
        {user.email && <p className="truncate text-sm text-muted-foreground">{user.email}</p>}
      </div>

      <UserBadges user={user} isAdmin={isAdmin} />
      <UserActions user={user} isAdmin={isAdmin} isSelf={isSelf} busy={busy} set={set} />
    </li>
  );
}

function UserBadges({ user, isAdmin }: { user: UserDto; isAdmin: boolean }) {
  return (
    <>
      {user.status === 'pending' && <Badge variant="warning">Pending</Badge>}
      {user.status === 'rejected' && <Badge variant="danger">Rejected</Badge>}
      {user.status === 'active' && user.autoApprove && !isAdmin && <Badge variant="success">Auto-approve</Badge>}
      {user.status === 'active' && <Badge variant={isAdmin ? 'info' : 'muted'}>{isAdmin ? 'Admin' : 'User'}</Badge>}
    </>
  );
}

function UserActions({
  user,
  isAdmin,
  isSelf,
  busy,
  set,
}: {
  user: UserDto;
  isAdmin: boolean;
  isSelf: boolean;
  busy: boolean;
  set: (patch: UserPatch) => void;
}) {
  return (
    <div className="flex shrink-0 gap-2">
      {user.status === 'pending' && (
        <>
          <Button variant="success" size="sm" loading={busy} onClick={() => set({ status: 'active' })}>
            Approve
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => set({ status: 'rejected' })}>
            Reject
          </Button>
        </>
      )}
      {user.status === 'rejected' && (
        <Button variant="success" size="sm" loading={busy} onClick={() => set({ status: 'active' })}>
          Approve
        </Button>
      )}
      {user.status === 'active' && (
        <Button
          variant={isAdmin ? 'secondary' : 'success'}
          size="sm"
          disabled={isSelf}
          loading={busy}
          title={isSelf ? "You can't change your own role" : undefined}
          onClick={() => set({ role: isAdmin ? 'user' : 'admin' })}
        >
          {isAdmin ? 'Demote' : 'Make admin'}
        </Button>
      )}
    </div>
  );
}
