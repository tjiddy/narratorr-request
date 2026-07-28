import type { MeDto, UserDto, UpdateUserBody, UpdateMeBody, AuthProvidersDto } from '@shared/schemas/user';
import type { RequestDto, RequestStatus } from '@shared/schemas/request';
import { isPublicHttpsUrl } from '@shared/schemas/request';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { ListEnvelope } from '@shared/schemas/v1/common';
import type {
  ConnectorSettingsDto,
  NotifierDto,
  UpdateConnectorSettingsBody,
  TestConnectorBody,
  TestConnectorResult,
  CreateNotifierBody,
  UpdateNotifierBody,
  NotifierTestBody,
} from '@shared/schemas/connectors';
import type { SystemInfoDto } from '@shared/schemas/system';
import type { FeaturesDto } from '@shared/schemas/features';
import type { PublicConfigDto } from '@shared/schemas/config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, 'NON_JSON', `Unexpected non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const envelope = json as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? `HTTP_${res.status}`,
      envelope?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return json as T;
}

const opts = (init?: RequestInit): RequestInit => ({ credentials: 'same-origin', ...init });

export const getMe = () => fetch('/api/me', opts()).then(parse<MeDto>);

/** Public, pre-auth config surface (instance badge). Reachable by both signed-in and signed-out tabs. */
export const getPublicConfig = () => fetch('/api/config', opts()).then(parse<PublicConfigDto>);

/** Update the caller's own requester-notification opt-in set. Self-scoped (PATCH /api/me). */
export const updateMe = (body: UpdateMeBody) =>
  fetch('/api/me', opts({
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<MeDto>);

export const searchCatalog = (q: string) =>
  fetch(`/api/search?q=${encodeURIComponent(q)}`, opts()).then(parse<{ data: V1AudibleResult[] }>);

/** Optional offset/limit paging for the list endpoints. Omitting both leaves the URL
 *  bare so the server applies its 50/0 default — the request set Search reads is unchanged. */
export interface PageParams {
  limit?: number;
  offset?: number;
}

/** Build `base` with a query string from the given params, omitting any that are absent
 *  (a bare base when nothing applies). Keeps `listMyRequests()` → bare `/api/requests`. */
function listUrl(base: string, params?: PageParams & { status?: RequestStatus }): string {
  const sp = new URLSearchParams();
  if (params?.status) sp.set('status', params.status);
  if (params?.limit !== undefined) sp.set('limit', String(params.limit));
  if (params?.offset !== undefined) sp.set('offset', String(params.offset));
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

export const listMyRequests = (params?: PageParams) =>
  fetch(listUrl('/api/requests', params), opts()).then(parse<ListEnvelope<RequestDto>>);

export const listAdminQueue = (status?: RequestStatus, params?: PageParams) =>
  fetch(listUrl('/api/admin/requests', { ...(status ? { status } : {}), ...params }), opts()).then(
    parse<ListEnvelope<RequestDto>>,
  );

export function requestBookFrom(result: V1AudibleResult) {
  const body = {
    asin: result.asin,
    title: result.title,
    author: result.authors[0]?.name ?? null,
    narrator: result.narrators[0]?.name ?? null,
    // The cover is decoration and the server's createRequestBodySchema rejects a
    // non-public-https coverUrl (SSRF refine) — drop a non-conforming cover to null
    // rather than failing the whole create over it.
    coverUrl: result.cover && isPublicHttpsUrl(result.cover) ? result.cover : null,
  };
  return fetch('/api/requests', opts({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<RequestDto>);
}

export const decideRequest = (publicId: string, action: 'approve' | 'deny', note?: string) =>
  fetch(`/api/admin/requests/${publicId}/decision`, opts({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, note: note ?? null }),
  })).then(parse<RequestDto>);

export const listUsers = () =>
  fetch('/api/admin/users', opts()).then(parse<ListEnvelope<UserDto>>);

export const updateUser = (publicId: string, patch: UpdateUserBody) =>
  fetch(`/api/admin/users/${publicId}`, opts({
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })).then(parse<UserDto>);

export const listUserRequests = (publicId: string, params?: PageParams) =>
  fetch(listUrl(`/api/admin/users/${publicId}/requests`, params), opts()).then(parse<ListEnvelope<RequestDto>>);

export const logout = () => fetch('/api/auth/logout', opts({ method: 'POST' })).then(parse<{ ok: true }>);

// --- Auth: login screen + local auth -----------------------------------------
export const getAuthProviders = () =>
  fetch('/api/auth/providers', opts()).then(parse<AuthProvidersDto>);

const postCredentials = (path: string, email: string, password: string) =>
  fetch(path, opts({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).then(parse<{ ok: true }>);

export const localLogin = (email: string, password: string) =>
  postCredentials('/api/auth/local/login', email, password);

export const localSignup = (email: string, password: string) =>
  postCredentials('/api/auth/local/signup', email, password);

export const getSystemInfo = () => fetch('/api/admin/system', opts()).then(parse<SystemInfoDto>);

/** Derived, instance-level feature state (issue #144). Active-user gated — 401/403 for anyone else. */
export const getFeatures = () => fetch('/api/features', opts()).then(parse<FeaturesDto>);

export const getConnectorSettings = () =>
  fetch('/api/admin/settings/connectors', opts()).then(parse<ConnectorSettingsDto>);

export const updateConnectorSettings = (body: UpdateConnectorSettingsBody) =>
  fetch('/api/admin/settings/connectors', opts({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<ConnectorSettingsDto>);

export const testConnector = (body: TestConnectorBody) =>
  fetch('/api/admin/settings/connectors/test', opts({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<TestConnectorResult>);

// --- Notifiers (admin): per-notifier CRUD + candidate test --------------------
export const createNotifier = (body: CreateNotifierBody) =>
  fetch('/api/admin/settings/notifiers', opts({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<NotifierDto>);

export const updateNotifier = (id: string, body: UpdateNotifierBody) =>
  fetch(`/api/admin/settings/notifiers/${encodeURIComponent(id)}`, opts({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<NotifierDto>);

export const deleteNotifier = (id: string) =>
  fetch(`/api/admin/settings/notifiers/${encodeURIComponent(id)}`, opts({ method: 'DELETE' })).then(
    parse<{ ok: true }>,
  );

export const testNotifier = (body: NotifierTestBody) =>
  fetch('/api/admin/settings/notifiers/test', opts({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(parse<TestConnectorResult>);
