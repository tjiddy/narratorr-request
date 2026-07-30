import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMe, useInstanceBadge } from './hooks';
import { logout } from './api';
import { resolveMeShell } from './app-shell';
import { unapprovedStatus } from '@shared/schemas/user';
import { Layout } from './components/Layout';
import { SearchPage } from './pages/SearchPage';
import { MyRequestsPage } from './pages/MyRequestsPage';
import { AdminQueuePage } from './pages/AdminQueuePage';
import { UsersPage } from './pages/UsersPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';

export function App() {
  // Apply the instance badge (favicon recolor + title prefix) for both signed-in and signed-out
  // tabs — must run before the auth/loading branches below so it isn't gated on auth state.
  useInstanceBadge();

  const me = useMe();

  // The whole shell policy is the pure `resolveMeShell` table (#168 AC6) — notably: a failed
  // refetch that RETAINED data keeps the session, because the settlement reconciliations the
  // mutation hooks now issue can fail on the same `buildMeDto()` tail the write just failed on.
  const shell = resolveMeShell(me);

  if (shell === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (shell === 'fatal') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-destructive">
        {me.error?.message}
      </div>
    );
  }

  // `shell === 'app'` already implies `me.data` is present; the second term is the type narrowing.
  if (shell === 'login' || !me.data) return <LoginPage />;

  const isAdmin = me.data.role === 'admin';

  // Authenticated but not (yet) approved. Derived from the SHARED approval policy (which already
  // exempts admins) rather than a local restatement, so this shell decision and the server's
  // `requireActiveUser` boundary can never drift apart.
  const unapproved = unapprovedStatus(me.data);
  if (unapproved) {
    return <AccountStatusScreen status={unapproved} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout me={me.data} />}>
          <Route index element={<SearchPage />} />
          <Route path="requests" element={<MyRequestsPage />} />
          <Route path="admin" element={isAdmin ? <AdminQueuePage /> : <Navigate to="/" replace />} />
          <Route path="users" element={isAdmin ? <UsersPage /> : <Navigate to="/" replace />} />
          <Route path="users/:publicId" element={isAdmin ? <UserDetailPage /> : <Navigate to="/" replace />} />
          <Route path="settings" element={isAdmin ? <SettingsPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

/** Shown to an authenticated user who hasn't been approved (pending) or was denied
 *  (rejected). The session is valid but they can't use the app yet. */
function AccountStatusScreen({ status }: { status: 'pending' | 'rejected' }) {
  const qc = useQueryClient();
  const pending = status === 'pending';

  async function signOut() {
    try {
      await logout();
    } finally {
      qc.clear();
      window.location.reload();
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gradient-bg noise-overlay px-4">
      <div className="glass-card w-full max-w-sm rounded-2xl p-8 text-center">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {pending ? 'Awaiting approval' : 'Access not approved'}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {pending
            ? "Your account is waiting for an administrator to approve it. You'll be able to request audiobooks once you're approved."
            : 'An administrator has not approved your account for this server.'}
        </p>
        <button
          onClick={signOut}
          className="mt-6 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
