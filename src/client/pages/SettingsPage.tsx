import { useState } from 'react';
import type { ElementType } from 'react';
import { useConnectorSettings } from '../hooks';
import { SlidersIcon, ServerIcon, BookIcon, BellIcon, ActivityIcon } from '../components/icons';
import { GeneralSection, NarratorrSection } from './SettingsConnection';
import { EbooksSection } from './SettingsEbooks';
import { NotifiersSection } from './SettingsNotifiers';
import { SystemSection } from './SettingsSystem';

// Settings shell: a narratorr-style left-nav sidebar over five sections (General /
// Narratorr / eBooks / Notifications / System). Sections are switched in local state rather
// than routed — the page lives under one `/settings` route and sub-routes would buy no visual
// gain. Each section owns its own form state + per-card save; only the active one is
// mounted. (System is read-only and fetches its own data.)

type SectionKey = 'general' | 'narratorr' | 'ebooks' | 'notifications' | 'system';

const NAV: { key: SectionKey; label: string; icon: ElementType }[] = [
  { key: 'general', label: 'General', icon: SlidersIcon },
  { key: 'narratorr', label: 'Narratorr', icon: ServerIcon },
  { key: 'ebooks', label: 'eBooks', icon: BookIcon },
  { key: 'notifications', label: 'Notifications', icon: BellIcon },
  { key: 'system', label: 'System', icon: ActivityIcon },
];

export function SettingsPage() {
  const { data, isLoading, error } = useConnectorSettings();
  const [active, setActive] = useState<SectionKey>('general');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Connect to narratorr and configure how you’re notified.</p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground/70">Loading…</p>}
      {error && <p className="text-sm text-destructive">Could not load settings.</p>}

      {data && (
        <div className="flex flex-col gap-8 lg:flex-row">
          {/* Sidebar — horizontal scroll row on narrow viewports, left column on lg+. */}
          <nav className="animate-fade-in-up stagger-1 shrink-0 lg:w-52">
            <div className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
              {NAV.map(({ key, label, icon: Icon }) => {
                const isActive = active === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActive(key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-3 whitespace-nowrap rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-glow'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="min-w-0 flex-1 animate-fade-in-up stagger-2">
            {active === 'general' && (
              <GeneralSection publicUrl={data.publicUrl} defaultQuota={data.defaultQuota} />
            )}
            {active === 'narratorr' && <NarratorrSection key={JSON.stringify(data.narratorr)} saved={data.narratorr} />}
            {active === 'ebooks' && (
              <EbooksSection
                ebooksEnabled={data.ebooksEnabled}
                notifiers={data.notifiers}
                kindleSender={data.kindleSender}
              />
            )}
            {active === 'notifications' && (
              <NotifiersSection
                notifiers={data.notifiers}
                publicUrl={data.publicUrl}
                requesterEmailWarning={data.requesterEmailWarning}
              />
            )}
            {active === 'system' && <SystemSection />}
          </div>
        </div>
      )}
    </div>
  );
}
