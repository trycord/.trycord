/**
 * The endpoint contracts.
 *
 * Every path, method and body the client uses against a Trycord instance is
 * named here once. A screen asks for a thing ("the channels of this
 * community") rather than assembling a URL, so the contract with the server
 * has one place to be read and one place to change.
 *
 * These functions take an ApiClient, which carries the instance's base address
 * and the bearer token for that instance.
 */

import {ApiClient, QueryParams} from './client';
import {
  ChannelTree,
  Community,
  Conversation,
  DeviceSession,
  InstanceInfo,
  InstanceListing,
  LegalInfo,
  LoginResult,
  Member,
  MfaChallenge,
  Message,
  NotificationPage,
  NotificationPrefs,
  PrivacySettings,
  TwoFactorStatus,
  User,
} from './types';
import {
  normalizeChannelTree,
  normalizeCommunity,
  normalizeConversation,
  normalizeDeviceSession,
  normalizeInstanceInfo,
  normalizeLegalInfo,
  normalizeMember,
  normalizeMessage,
  normalizeNotificationPage,
  normalizeNotificationPrefs,
  normalizePrivacySettings,
  normalizeTwoFactorStatus,
  normalizeUser,
} from './normalize';

// --- instance and public documents ----------------------------------------

export async function instanceInfo(client: ApiClient): Promise<InstanceInfo> {
  const raw = await client.get<unknown>('/api/instance', {auth: false});
  return normalizeInstanceInfo(raw);
}

export async function legal(client: ApiClient): Promise<LegalInfo> {
  const raw = await client.get<unknown>('/api/legal', {auth: false});
  return normalizeLegalInfo(raw);
}

export async function discoverInstances(
  client: ApiClient,
): Promise<InstanceListing[]> {
  const raw = await client.get<{instances?: unknown}>(
    '/api/discovery/instances',
    {auth: false},
  );
  const entries = Array.isArray(raw && raw.instances) ? raw.instances : [];
  const out: InstanceListing[] = [];
  for (const entry of entries) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : '';
    if (!url) continue;
    out.push({
      name: typeof record.name === 'string' ? record.name : url,
      url,
      description: typeof record.description === 'string' ? record.description : null,
    });
  }
  return out;
}

// --- authentication --------------------------------------------------------

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Signs in. The server answers either with a session or with a challenge when
 * the account has a second factor, and the two are told apart by the shape of
 * the answer rather than by the status code.
 */
export async function login(
  client: ApiClient,
  credentials: Credentials,
): Promise<LoginResult | MfaChallenge> {
  const raw = await client.post<Record<string, unknown>>(
    '/api/auth/login',
    {username: credentials.username, password: credentials.password},
    {auth: false},
  );
  return readAuthOutcome(raw);
}

export async function twoFactorVerify(
  client: ApiClient,
  challengeToken: string,
  code: string,
): Promise<LoginResult> {
  const raw = await client.post<Record<string, unknown>>(
    '/api/auth/2fa/verify',
    {challengeToken, code},
    {auth: false},
  );
  const record = raw ?? {};
  return {token: String(record.token ?? ''), user: (record.user ?? {}) as LoginResult['user']};
}

/**
 * Asks for a password reset message.
 *
 * The answer is the same whether or not the account exists, so nothing here
 * can be used to find out who has one.
 */
export async function forgotPassword(
  client: ApiClient,
  email: string,
): Promise<void> {
  await client.post('/api/auth/forgot-password', {email}, {auth: false});
}

/**
 * Sets a new password from a reset token.
 *
 * The answer is a session, or a challenge when the account has a second
 * factor: a reset proves control of the mailbox, not of the authenticator, so
 * the factor still has to be presented.
 */
export async function resetPassword(
  client: ApiClient,
  token: string,
  newPassword: string,
  confirmPassword: string,
): Promise<LoginResult | MfaChallenge> {
  const raw = await client.post<Record<string, unknown>>(
    '/api/auth/reset-password',
    {token, newPassword, confirmPassword},
    {auth: false},
  );
  return readAuthOutcome(raw);
}

/**
 * Reads an answer that is either a session or a second-factor challenge.
 */
function readAuthOutcome(raw: Record<string, unknown> | null): LoginResult | MfaChallenge {
  const record = raw ?? {};
  if (record.mfaRequired === true && typeof record.challengeToken === 'string') {
    return {
      mfaRequired: true,
      challengeToken: record.challengeToken,
      expiresInSeconds:
        typeof record.expiresInSeconds === 'number' ? record.expiresInSeconds : 0,
    };
  }
  return {token: String(record.token ?? ''), user: (record.user ?? {}) as LoginResult['user']};
}

export interface RegistrationPayload {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
  /** The exact version of the Terms the person accepted. */
  termsVersion: string;
  /** The exact version of the Privacy Policy the person accepted. */
  privacyVersion: string;
}

/**
 * Creates an account.
 *
 * The server refuses a registration whose accepted versions do not match the
 * versions in force, so the caller must pass the versions it showed the
 * person - never a guess.
 */
export async function register(
  client: ApiClient,
  payload: RegistrationPayload,
): Promise<LoginResult | null> {
  const body: Record<string, unknown> = {
    username: payload.username,
    password: payload.password,
    termsVersion: payload.termsVersion,
    privacyVersion: payload.privacyVersion,
  };
  if (payload.displayName) body.displayName = payload.displayName;
  if (payload.email) body.email = payload.email;

  const raw = await client.post<Record<string, unknown> | null>(
    '/api/auth/register',
    body,
    {auth: false},
  );
  if (!raw || typeof raw.token !== 'string' || !raw.token) return null;
  return {token: raw.token, user: (raw.user ?? {}) as LoginResult['user']};
}

export async function logout(client: ApiClient): Promise<void> {
  await client.post('/api/auth/logout');
}

export async function twoFactorStatus(client: ApiClient): Promise<TwoFactorStatus> {
  const raw = await client.get<unknown>('/api/auth/2fa/status');
  return normalizeTwoFactorStatus(raw);
}

export async function twoFactorSetup(
  client: ApiClient,
  password: string,
): Promise<{secret: string}> {
  const raw = await client.post<{secret?: string}>('/api/auth/2fa/setup', {password});
  return {secret: (raw && raw.secret) || ''};
}

export async function twoFactorEnable(
  client: ApiClient,
  password: string,
  code: string,
): Promise<{recoveryCodes: string[]}> {
  const raw = await client.post<{recoveryCodes?: string[]}>(
    '/api/auth/2fa/enable',
    {password, code},
  );
  return {recoveryCodes: (raw && raw.recoveryCodes) || []};
}

export async function sessions(client: ApiClient): Promise<DeviceSession[]> {
  const raw = await client.get<unknown>('/api/auth/sessions');
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as {sessions?: unknown[]})?.sessions)
      ? ((raw as {sessions: unknown[]}).sessions as unknown[])
      : [];
  const out: DeviceSession[] = [];
  for (const entry of entries) {
    const session = normalizeDeviceSession(entry, null);
    if (session) out.push(session);
  }
  return out;
}

export async function revokeOtherSessions(client: ApiClient): Promise<void> {
  await client.post('/api/auth/sessions/revoke-others');
}

export async function changePassword(
  client: ApiClient,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await client.post('/api/auth/change-password', {currentPassword, newPassword});
}

// --- account ---------------------------------------------------------------

export async function me(client: ApiClient): Promise<User | null> {
  const raw = await client.get<unknown>('/api/users/me');
  return normalizeUser(raw);
}

export async function updateMe(
  client: ApiClient,
  body: {displayName?: string; bio?: string; statusText?: string},
): Promise<User | null> {
  const raw = await client.patch<unknown>('/api/users/me', body);
  return normalizeUser(raw);
}

/** A person's public profile. */
export async function userProfile(
  client: ApiClient,
  userId: string,
): Promise<User | null> {
  const raw = await client.get<unknown>(`/api/users/${encodeURIComponent(userId)}`);
  return normalizeUser(raw);
}

/** Asks for a new verification message for the account's address. */
export async function resendVerificationEmail(client: ApiClient): Promise<void> {
  await client.post('/api/auth/verify-email/resend');
}

// --- communities -----------------------------------------------------------

export async function communities(client: ApiClient): Promise<Community[]> {
  const raw = await client.get<unknown>('/api/servers');
  const entries = Array.isArray(raw) ? raw : [];
  const out: Community[] = [];
  for (const entry of entries) {
    const community = normalizeCommunity(entry);
    if (community) out.push(community);
  }
  return out;
}

export async function community(
  client: ApiClient,
  serverId: string,
): Promise<Community | null> {
  const raw = await client.get<unknown>(`/api/servers/${encodeURIComponent(serverId)}`);
  return normalizeCommunity(raw);
}

export async function channelTree(
  client: ApiClient,
  serverId: string,
): Promise<ChannelTree> {
  const raw = await client.get<unknown>(
    `/api/servers/${encodeURIComponent(serverId)}/channels`,
  );
  return normalizeChannelTree(raw, serverId);
}

export async function members(
  client: ApiClient,
  serverId: string,
  options: {limit?: number; offset?: number; q?: string} = {},
): Promise<Member[]> {
  const query: QueryParams = {};
  if (typeof options.limit === 'number') query.limit = options.limit;
  if (typeof options.offset === 'number') query.offset = options.offset;
  if (options.q) query.q = options.q;
  const raw = await client.get<unknown>(
    `/api/servers/${encodeURIComponent(serverId)}/members`,
    {query},
  );
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as {members?: unknown[]})?.members)
      ? ((raw as {members: unknown[]}).members as unknown[])
      : [];
  const out: Member[] = [];
  for (const entry of entries) {
    const member = normalizeMember(entry);
    if (member) out.push(member);
  }
  return out;
}

// --- messages --------------------------------------------------------------

export interface MessagePageOptions {
  before?: number | string;
  after?: number | string;
  limit?: number;
}

export async function channelMessages(
  client: ApiClient,
  channelId: string,
  options: MessagePageOptions = {},
): Promise<Message[]> {
  const query: QueryParams = {};
  if (options.before !== undefined) query.before = options.before;
  if (options.after !== undefined) query.after = options.after;
  if (options.limit !== undefined) query.limit = options.limit;
  const raw = await client.get<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {query},
  );
  return toMessages(raw);
}

export async function sendChannelMessage(
  client: ApiClient,
  channelId: string,
  body: {content: string; attachmentIds?: string[]; replyToId?: string},
): Promise<Message | null> {
  const raw = await client.post<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    body,
  );
  return normalizeMessage(raw);
}

export async function conversations(client: ApiClient): Promise<Conversation[]> {
  const raw = await client.get<unknown>('/api/dms');
  const entries = Array.isArray(raw) ? raw : [];
  const out: Conversation[] = [];
  for (const entry of entries) {
    const conversation = normalizeConversation(entry);
    if (conversation) out.push(conversation);
  }
  return out;
}

export async function conversation(
  client: ApiClient,
  conversationId: string,
): Promise<Conversation | null> {
  const raw = await client.get<unknown>(`/api/dms/${encodeURIComponent(conversationId)}`);
  return normalizeConversation(raw);
}

export async function directMessages(
  client: ApiClient,
  conversationId: string,
  options: MessagePageOptions = {},
): Promise<Message[]> {
  const query: QueryParams = {};
  if (options.before !== undefined) query.before = options.before;
  if (options.after !== undefined) query.after = options.after;
  if (options.limit !== undefined) query.limit = options.limit;
  const raw = await client.get<unknown>(
    `/api/dms/${encodeURIComponent(conversationId)}/messages`,
    {query},
  );
  return toMessages(raw);
}

export async function sendDirectMessage(
  client: ApiClient,
  conversationId: string,
  body: {content: string; attachmentIds?: string[]},
): Promise<Message | null> {
  const raw = await client.post<unknown>(
    `/api/dms/${encodeURIComponent(conversationId)}/messages`,
    body,
  );
  return normalizeMessage(raw);
}

export async function markConversationRead(
  client: ApiClient,
  conversationId: string,
): Promise<void> {
  await client.post(`/api/dms/${encodeURIComponent(conversationId)}/read`);
}

// --- notifications ---------------------------------------------------------

export async function notificationPage(
  client: ApiClient,
  options: {limit?: number; before?: string} = {},
): Promise<NotificationPage> {
  const query: QueryParams = {limit: options.limit ?? 30};
  if (options.before) query.before = options.before;
  const raw = await client.get<unknown>('/api/notifications', {query});
  return normalizeNotificationPage(raw);
}

export async function markAllNotificationsRead(client: ApiClient): Promise<void> {
  await client.post('/api/notifications/read-all');
}

// --- privacy and notification preferences ----------------------------------

export async function privacySettings(client: ApiClient): Promise<PrivacySettings> {
  const raw = await client.get<unknown>('/api/me/privacy');
  return normalizePrivacySettings(raw);
}

export async function savePrivacySettings(
  client: ApiClient,
  body: Partial<PrivacySettings>,
): Promise<PrivacySettings> {
  const raw = await client.patch<unknown>('/api/me/privacy', body);
  return normalizePrivacySettings(raw);
}

export async function notificationPreferences(
  client: ApiClient,
  serverId?: string,
): Promise<NotificationPrefs> {
  const query: QueryParams = {};
  if (serverId) query.serverId = serverId;
  const raw = await client.get<unknown>('/api/me/notification-prefs', {query});
  return normalizeNotificationPrefs(raw);
}

export async function saveNotificationPreferences(
  client: ApiClient,
  body: Partial<NotificationPrefs>,
): Promise<NotificationPrefs> {
  const raw = await client.patch<unknown>('/api/me/notification-prefs', body);
  return normalizeNotificationPrefs(raw);
}

// --- realtime --------------------------------------------------------------

/**
 * A one-use ticket for the socket handshake.
 *
 * The socket cannot present an Authorization header, so it spends a ticket
 * instead. The ticket is fetched over HTTPS and never travels in a URL
 * otherwise.
 */
export async function realtimeTicket(client: ApiClient): Promise<string> {
  const raw = await client.post<{ticket?: string}>('/api/auth/ws/ticket');
  return (raw && raw.ticket) || '';
}

function toMessages(raw: unknown): Message[] {
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as {messages?: unknown[]})?.messages)
      ? ((raw as {messages: unknown[]}).messages as unknown[])
      : [];
  const out: Message[] = [];
  for (const entry of entries) {
    const message = normalizeMessage(entry);
    if (message) out.push(message);
  }
  out.sort(bySequence);
  return out;
}

function bySequence(a: Message, b: Message): number {
  const left = a.seq === null ? 0 : a.seq;
  const right = b.seq === null ? 0 : b.seq;
  if (left !== right) return left - right;
  return timestamp(a.createdAt) - timestamp(b.createdAt);
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
