import type { AppConfig } from '../config.js';
import type { Db } from '../../db/client.js';
import type { UserService } from './user.service.js';
import type { SettingsService } from './settings.service.js';
import type { RequestService } from './request.service.js';
import type { SearchService } from './search.service.js';
import type { OidcService, OidcProfile } from './oidc.service.js';
import type { OidcProviderConfig } from '../config.js';
import type { Notifier } from './notifications/index.js';
import type { ConnectorSettingsService } from './connector-settings.service.js';
import type { NarratorrClientHolder } from './narratorr-client-holder.js';
import type { FeatureService } from './feature.service.js';

/** Wired-up service container handed to the route registrars. */
export interface AppDeps {
  config: AppConfig;
  db: Db;
  users: UserService;
  settings: SettingsService;
  requests: RequestService;
  search: SearchService;
  /** Connector config (narratorr + notifications) read/written by the Settings page. */
  connectorSettings: ConnectorSettingsService;
  /** The swappable narratorr connection (JSON + raw stream) — rebuilt live when it is saved. */
  narratorr: NarratorrClientHolder;
  /** Total, cached companion-ebook capability resolver; keyed to {@link narratorr}'s generation,
   *  so a connection swap retires the previous server's cached answer by construction. */
  features: FeatureService;
  /** Fire-and-forget notification dispatcher; reassigned live when channels are saved. */
  notifier: Notifier;
  /** Configured OIDC providers (login service + display config), keyed by provider id.
   *  Empty in AUTH_BYPASS mode or when no OIDC_PROVIDERS are set. */
  oidc: Map<string, { service: OidcService<OidcProfile>; config: OidcProviderConfig }>;
}
