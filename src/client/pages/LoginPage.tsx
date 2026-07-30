import { useState, type FormEvent } from 'react';
import { useAuthProviders, useLocalAuth } from '../hooks';
import { ApiError } from '../api';

const inputCls =
  'w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';

export function LoginPage() {
  const providers = useAuthProviders();
  // A failed OIDC callback bounces back here with ?login_error=oidc (see auth route).
  const oidcError =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('login_error') === 'oidc';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gradient-bg noise-overlay px-4">
      <div className="glass-card w-full max-w-sm rounded-2xl p-8">
        <h1 className="text-center font-display text-2xl font-semibold tracking-tight">Requests</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">Sign in to request audiobooks for the library.</p>

        {oidcError && (
          <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">
            Sign-in failed. Please try again.
          </p>
        )}

        {providers.isLoading && <p className="mt-6 text-center text-sm text-muted-foreground/70">Loading…</p>}
        {providers.error && (
          <p className="mt-6 text-center text-sm text-destructive">Could not load sign-in options. Try again.</p>
        )}

        {providers.data && (
          <div className="mt-6 flex flex-col gap-4">
            {providers.data.local && <LocalAuthForm />}

            {providers.data.local && providers.data.providers.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground/60">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
            )}

            <div className="flex flex-col gap-2">
              {providers.data.providers.map((p) => (
                <a
                  key={p.id}
                  href={`/api/auth/oidc/${p.id}/login`}
                  className="inline-flex w-full items-center justify-center rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium transition-all hover:border-primary hover:text-primary focus-ring"
                >
                  Continue with {p.label}
                </a>
              ))}
            </div>

            {!providers.data.local && providers.data.providers.length === 0 && (
              <p className="text-center text-sm text-destructive">
                No sign-in methods are configured. Set <code className="text-xs">LOCAL_AUTH</code> or an OIDC provider.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LocalAuthForm() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const auth = useLocalAuth(mode);

  function submit(e: FormEvent) {
    e.preventDefault();
    auth.mutate({ email: email.trim(), password });
  }

  const errorMsg = auth.error ? (auth.error instanceof ApiError ? auth.error.message : 'Something went wrong') : null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <input
        className={inputCls}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
      />
      <input
        className={inputCls}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        required
      />
      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
      <button
        type="submit"
        disabled={auth.isPending}
        className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-all hover:opacity-90 focus-ring disabled:opacity-50"
      >
        {auth.isPending ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
      </button>
      {/* Disabled while an attempt is in flight (#201 F2). `auth.reset()` DETACHES this observer
          from the still-running mutation and republishes an idle result, so leaving it live would
          drop `isPending` mid-flight and re-enable Submit above — letting a second credentials POST
          go out at a rate-limited route while the first is still settling. The stranded-session
          hazard that made this urgent is fixed in `reconcileMeWrite` (it cancels before
          invalidating, so the last settlement always reads fresh); this keeps the form itself to
          one attempt at a time. */}
      <button
        type="button"
        disabled={auth.isPending}
        onClick={() => {
          setMode((m) => (m === 'login' ? 'signup' : 'login'));
          auth.reset();
        }}
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
      >
        {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
      </button>
    </form>
  );
}
