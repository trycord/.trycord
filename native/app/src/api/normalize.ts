/**
 * Normalisation.
 *
 * The server answers the same idea in more than one spelling. Every raw
 * payload that arrives from the wire passes through here, so a screen only
 * ever sees one shape. The rules are the ones the web client uses, because
 * both clients read the same server.
 */

import {
  Attachment,
  Channel,
  ChannelCategory,
  ChannelTree,
  Community,
  Conversation,
  DeviceSession,
  InstanceInfo,
  LegalInfo,
  Member,
  Message,
  MessageEmbed,
  NotificationItem,
  NotificationPage,
  NotificationPrefs,
  PrivacySettings,
  Reaction,
  TwoFactorStatus,
  User,
} from './types';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

export function normalizeUser(raw: unknown): User | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const id = asString(pick(source, 'id', 'userId', 'user_id'));
  if (!id) return null;
  const username = asString(pick(source, 'username', 'handle')) || '';
  return {
    id,
    username,
    displayName:
      asString(pick(source, 'display_name', 'displayName')) || username || 'Unknown',
    nickname: asString(pick(source, 'nickname')),
    avatarUrl: asString(pick(source, 'avatar_url', 'avatarUrl')),
    bannerUrl: asString(pick(source, 'banner_url', 'bannerUrl')),
    bio: asString(pick(source, 'bio')),
    statusText: asString(pick(source, 'status_text', 'statusText')),
    isBot: asBoolean(pick(source, 'is_bot', 'isBot')),
    isOwner: asBoolean(pick(source, 'is_owner', 'isOwner')),
    isAdmin: asBoolean(pick(source, 'isAdmin', 'is_admin')),
    email: asString(pick(source, 'email')),
    emailVerified: asBoolean(pick(source, 'email_verified', 'emailVerified')),
    createdAt: asString(pick(source, 'created_at', 'createdAt')),
  };
}

export function normalizeInstanceInfo(raw: unknown): InstanceInfo {
  const source = asRecord(raw);
  const registration = asRecord(source.registration);
  return {
    instanceId: asString(pick(source, 'instanceId', 'instance_id')),
    name: asString(pick(source, 'name')) || 'Trycord',
    description: asString(pick(source, 'description')) || '',
    version: asString(pick(source, 'version')),
    apiVersion: asString(pick(source, 'apiVersion', 'api_version')),
    protocolVersion: asString(pick(source, 'protocolVersion', 'protocol_version')),
    registration: {
      enabled: asBoolean(pick(registration, 'enabled')),
      approvalRequired: asBoolean(pick(registration, 'approvalRequired', 'approval_required')),
      emailVerificationRequired: asBoolean(
        pick(registration, 'emailVerificationRequired', 'email_verification_required'),
      ),
    },
  };
}

export function normalizeLegalInfo(raw: unknown): LegalInfo {
  const source = asRecord(raw);
  return {
    termsVersion: asString(pick(source, 'termsVersion', 'terms_version')) || '1.0',
    privacyVersion: asString(pick(source, 'privacyVersion', 'privacy_version')) || '1.0',
    updated: asString(pick(source, 'updated')),
  };
}

export function normalizeCommunity(raw: unknown): Community | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const id = asString(pick(source, 'id', 'serverId', 'server_id'));
  if (!id) return null;
  const rawPermissions = source.permissions;
  const permissions = Array.isArray(rawPermissions)
    ? rawPermissions.map(entry => asString(entry)).filter((entry): entry is string => !!entry)
    : [];
  return {
    id,
    name: asString(pick(source, 'name', 'display_name', 'displayName')) || 'Community',
    description: asString(pick(source, 'description')),
    slug: asString(pick(source, 'slug')),
    iconUrl: asString(pick(source, 'icon_url', 'iconUrl')),
    bannerUrl: asString(pick(source, 'banner_url', 'bannerUrl')),
    isOwner: asBoolean(pick(source, 'is_owner', 'isOwner')),
    memberCount: asNumber(pick(source, 'member_count', 'memberCount')),
    unreadCount: asNumber(pick(source, 'unread_count', 'unreadCount')) || 0,
    position: asNumber(pick(source, 'position')) || 0,
    permissions,
  };
}

export function normalizeChannel(raw: unknown, serverId?: string | null): Channel | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const id = asString(pick(source, 'id', 'channelId', 'channel_id'));
  if (!id) return null;
  return {
    id,
    serverId: asString(pick(source, 'server_id', 'serverId')) ?? serverId ?? null,
    name: asString(pick(source, 'name')) || 'channel',
    type: asString(pick(source, 'type')) || 'text',
    topic: asString(pick(source, 'topic')),
    position: asNumber(pick(source, 'position')) || 0,
    categoryId: asString(pick(source, 'category_id', 'categoryId')),
    unreadCount: asNumber(pick(source, 'unread_count', 'unreadCount')) || 0,
    lastMessageAt: asString(pick(source, 'last_message_at', 'lastMessageAt')),
  };
}

export function normalizeChannelTree(raw: unknown, serverId: string): ChannelTree {
  const source = asRecord(raw);
  const rawCategories = Array.isArray(source.categories) ? source.categories : [];
  const rawChannels = Array.isArray(source.channels) ? source.channels : [];
  const categories: ChannelCategory[] = [];
  for (const entry of rawCategories) {
    const record = asRecord(entry);
    const id = asString(pick(record, 'id'));
    if (!id) continue;
    categories.push({
      id,
      name: asString(pick(record, 'name')) || 'Category',
      position: asNumber(pick(record, 'position')) || 0,
    });
  }
  const channels: Channel[] = [];
  for (const entry of rawChannels) {
    const channel = normalizeChannel(entry, serverId);
    if (channel) channels.push(channel);
  }
  channels.sort((a, b) => a.position - b.position);
  categories.sort((a, b) => a.position - b.position);
  return {categories, channels};
}

function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const id = asString(pick(record, 'id'));
    if (!id) continue;
    out.push({
      id,
      filename: asString(pick(record, 'filename', 'name')),
      contentType: asString(pick(record, 'content_type', 'contentType', 'mime_type')),
      size: asNumber(pick(record, 'size', 'bytes')),
      url: asString(pick(record, 'url')),
    });
  }
  return out;
}

function normalizeReactions(raw: unknown): Reaction[] {
  if (!Array.isArray(raw)) return [];
  const out: Reaction[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const emoji = asString(pick(record, 'emoji'));
    if (!emoji) continue;
    out.push({
      emoji,
      count: asNumber(pick(record, 'count')) || 0,
      mine: asBoolean(pick(record, 'mine', 'isMine')),
    });
  }
  return out;
}

function normalizeEmbeds(raw: unknown): MessageEmbed[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageEmbed[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    out.push({
      url: asString(pick(record, 'url')),
      title: asString(pick(record, 'title')),
      description: asString(pick(record, 'description')),
    });
  }
  return out;
}

export function normalizeMessage(raw: unknown): Message | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const id = asString(pick(source, 'id', 'messageId', 'message_id'));
  if (!id) return null;
  const authorId = asString(pick(source, 'authorId', 'author_id', 'userId', 'user_id'));
  return {
    id,
    seq: asNumber(pick(source, 'seq')),
    content: asString(pick(source, 'content', 'body')) || '',
    createdAt: asString(pick(source, 'createdAt', 'created_at', 'timestamp')),
    editedAt: asString(pick(source, 'editedAt', 'edited_at')),
    authorId,
    authorName: asString(pick(source, 'authorName', 'author_name', 'username', 'user')),
    authorDisplay: asString(
      pick(source, 'authorDisplay', 'author_display', 'display_name', 'displayName'),
    ),
    authorAvatar: asString(pick(source, 'authorAvatar', 'author_avatar', 'avatar_url')),
    replyCount: asNumber(pick(source, 'replyCount', 'reply_count')) || 0,
    attachments: normalizeAttachments(pick(source, 'attachments')),
    reactions: normalizeReactions(pick(source, 'reactions')),
    embeds: normalizeEmbeds(pick(source, 'embeds')),
    pinned: asBoolean(pick(source, 'pinned')),
  };
}

export function normalizeConversation(raw: unknown): Conversation | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const id = asString(pick(source, 'id', 'conversationId', 'conversation_id'));
  if (!id) return null;
  const rawMessages = Array.isArray(source.messages) ? source.messages : [];
  const messages: Message[] = [];
  for (const entry of rawMessages) {
    const message = normalizeMessage(entry);
    if (message) messages.push(message);
  }
  return {
    id,
    peer: normalizeUser(source.peer),
    lastMessageAt: asString(pick(source, 'lastMessageAt', 'last_message_at')),
    unreadCount: asNumber(pick(source, 'unreadCount', 'unread_count')) || 0,
    messages,
  };
}

export function normalizeMember(raw: unknown): Member | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const user = normalizeUser(pick(source, 'user', 'member') ?? source);
  if (!user) return null;
  return {
    user,
    role: asString(pick(source, 'role', 'role_name')),
    joinedAt: asString(pick(source, 'joined_at', 'joinedAt')),
  };
}

export function normalizeNotification(raw: unknown): NotificationItem | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const id = asString(pick(source, 'id'));
  if (!id) return null;
  return {
    id,
    type: asString(pick(source, 'type')) || 'notification',
    createdAt: asString(pick(source, 'createdAt', 'created_at')),
    readAt: asString(pick(source, 'readAt', 'read_at')),
    referenceId: asString(pick(source, 'referenceId', 'reference_id')),
    actor: normalizeUser(source.actor),
  };
}

export function normalizeNotificationPage(raw: unknown): NotificationPage {
  const source = asRecord(raw);
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items: NotificationItem[] = [];
  for (const entry of rawItems) {
    const item = normalizeNotification(entry);
    if (item) items.push(item);
  }
  return {
    items,
    unreadCount: asNumber(pick(source, 'unreadCount', 'unread_count')) || 0,
    hasMore: asBoolean(pick(source, 'hasMore', 'has_more')),
    nextCursor: asString(pick(source, 'nextCursor', 'next_cursor')),
  };
}

export function normalizeDeviceSession(raw: unknown, ownJti: string | null): DeviceSession | null {
  if (!raw) return null;
  const source = asRecord(raw);
  const jti = asString(pick(source, 'jti', 'id'));
  if (!jti) return null;
  return {
    jti,
    createdAt: asString(pick(source, 'createdAt', 'created_at')),
    lastUsedAt: asString(pick(source, 'lastUsedAt', 'last_used_at')),
    userAgent: asString(pick(source, 'userAgent', 'user_agent', 'device')),
    current: !!ownJti && jti === ownJti,
  };
}

export function normalizePrivacySettings(raw: unknown): PrivacySettings {
  const source = asRecord(raw);
  return {
    allowDmsFrom: readChoice(pick(source, 'allowDmsFrom', 'allow_dms_from'), 'anyone'),
    allowFriendRequests: readChoice(
      pick(source, 'allowFriendRequests', 'allow_friend_requests'),
      'anyone',
    ),
    showOnline: asBoolean(pick(source, 'showOnline', 'show_online')),
    showReadReceipts: asBoolean(pick(source, 'showReadReceipts', 'show_read_receipts')),
    showProfile: readProfileChoice(pick(source, 'showProfile', 'show_profile')),
    allowSearch: asBoolean(pick(source, 'allowSearch', 'allow_search')),
  };
}

export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  const source = asRecord(raw);
  return {
    notifyOnMention: asBoolean(pick(source, 'notifyOnMention', 'notify_on_mention')),
    notifyOnDm: asBoolean(pick(source, 'notifyOnDm', 'notify_on_dm')),
    notifyOnFriendRequest: asBoolean(
      pick(source, 'notifyOnFriendRequest', 'notify_on_friend_request'),
    ),
    notifyOnReply: asBoolean(pick(source, 'notifyOnReply', 'notify_on_reply')),
    quietHoursEnabled: asBoolean(pick(source, 'quietHoursEnabled', 'quiet_hours_enabled')),
    quietHoursStart: asString(pick(source, 'quietHoursStart', 'quiet_hours_start')),
    quietHoursEnd: asString(pick(source, 'quietHoursEnd', 'quiet_hours_end')),
  };
}

export function normalizeTwoFactorStatus(raw: unknown): TwoFactorStatus {
  const source = asRecord(raw);
  return {
    enabled: asBoolean(pick(source, 'enabled', 'totp_enabled')),
    pending: asBoolean(pick(source, 'pending')),
  };
}

function readChoice(value: unknown, fallback: PrivacySettings['allowDmsFrom']) {
  if (value === 'anyone' || value === 'friends' || value === 'nobody') return value;
  return fallback;
}

function readProfileChoice(value: unknown): PrivacySettings['showProfile'] {
  if (value === 'everyone' || value === 'members' || value === 'nobody') return value;
  return 'everyone';
}
