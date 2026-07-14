import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, type ComponentType } from 'react';
import type { MeDto } from '@shared/schemas/user';
import { logout } from '../api';
import { useTheme } from '../hooks';
import { Button } from './Button';
import { AccountModal } from './AccountModal';
import { ErrorBoundary } from './ErrorBoundary';
import { SunIcon, MoonIcon, HeadphonesIcon, SearchIcon, InboxIcon, ActivityIcon, UsersIcon, SettingsIcon } from './icons';

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  adminOnly?: boolean;
};

const navItems: NavItem[] = [
  { to: '/', label: 'Request', icon: SearchIcon, end: true },
  { to: '/requests', label: 'My Requests', icon: InboxIcon },
  { to: '/admin', label: 'Queue', icon: ActivityIcon, adminOnly: true },
  { to: '/users', label: 'Users', icon: UsersIcon, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, adminOnly: true },
];

// Pill nav, mirrored from Narratorr's Layout: rounded-xl pills, active link gets
// the solid primary fill + glow, the rest are muted with a hover wash.
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `relative flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 ease-out sm:px-4 sm:py-2.5 ${
    isActive
      ? 'bg-primary text-primary-foreground shadow-glow'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

export function Layout({ me }: { me: MeDto }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountInitial = me.username.charAt(0).toUpperCase() || '?';

  async function onLogout() {
    try {
      await logout();
      qc.clear();
      await navigate('/');
      window.location.reload();
    } catch {
      toast.error('Logout failed');
    }
  }

  return (
    <div className="min-h-screen gradient-bg noise-overlay">
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:h-20">
          {/* Logo — gradient headphones badge with a soft glow, mirrored from Narratorr. */}
          <NavLink to="/" end className="group flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-xl bg-primary/20 blur-xl transition-colors group-hover:bg-primary/30" />
              <div className="relative rounded-xl bg-gradient-to-br from-primary to-amber-500 p-2.5">
                <HeadphonesIcon className="h-6 w-6 text-primary-foreground" />
              </div>
            </div>
            <span className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
              Requests
            </span>
          </NavLink>

          <div className="flex items-center gap-1 sm:gap-2">
            <nav className="flex items-center gap-1 sm:gap-2">
              {navItems
                .filter((item) => !item.adminOnly || me.role === 'admin')
                .map(({ to, label, icon: Icon, end }) => (
                  <NavLink key={to} to={to} end={end ?? false} className={navLinkClass}>
                    <Icon className="h-4 w-4" />
                    <span className="hidden sm:inline">{label}</span>
                  </NavLink>
                ))}
            </nav>
            <div className="ml-1 flex items-center gap-2 sm:gap-3 text-sm">
              {/* Account trigger — avatar + username, opens the account modal (#131). The avatar is
                  always visible so the modal is reachable on mobile too (account preferences moved
                  here off My Requests); the username + admin star show from `sm` up. */}
              <button
                type="button"
                onClick={() => setAccountOpen(true)}
                aria-haspopup="dialog"
                aria-label="Account"
                className="flex items-center gap-2 rounded-xl px-1.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring sm:px-2"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-amber-500 text-xs font-semibold text-primary-foreground">
                  {accountInitial}
                </span>
                <span className="hidden sm:inline">{me.username}</span>
                {me.role === 'admin' && <span className="hidden text-primary sm:inline">★</span>}
              </button>
              <Button
                variant="ghost"
                size="sm"
                icon={theme === 'dark' ? SunIcon : MoonIcon}
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              />
              <Button variant="ghost" size="sm" onClick={onLogout}>
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </header>
      <AccountModal me={me} open={accountOpen} onClose={() => setAccountOpen(false)} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        {/*
          Reset the boundary on navigation. We key on the full `pathname` (params included),
          so a param-only move like `/users/:publicId` also clears a broken detail page. We
          pass `resetKey` (state reset in getDerivedStateFromProps) rather than `key={pathname}`
          (subtree remount) deliberately: `key=` would tear down and rebuild the healthy Outlet
          subtree on every param change, and — being a React reconciliation behaviour — has no
          pure seam to node-test (AC 3). `resetKey` clears only the boundary's own error state.
        */}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
