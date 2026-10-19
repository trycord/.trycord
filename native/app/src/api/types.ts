/**
 * The shapes the server speaks and the shapes this client prefers.
 *
 * The wire is not uniform: /api/users/me answers camelCase while the member
 * roster answers snake_case, because they were written at different times.
 * The raw types below describe what may arrive; the normalised types describe
 * what the screens work with. Nothing outside src/api should have to know
 * which of the two it is holding.
 */

export type Id = string;

export interface RawUser {
  id?: Id;
  username?: string;
  display_name?: string | null;
  displayName?: string | null;
  nickname?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  banner_url?: string | null;
  bannerUrl?: string | null;
  bio?: string | null;
  status_text?: string | null;
  statusText?: string | null;
  is_bot?: boolean;
  isBot?: boolean;
  is_owner?: boolean;
  isOwner?: boolean;
  isAdmin?: boolean;
  email?: string | null;
  email_verified?: boolean;
  emailVerified?: boolean;
  created_at?: string | null;
  createdAt?: string | null;
  joined_at?: string | null;
  joinedAt?: string | null;
  [key: string]: unknown;
}

export interface User {
  id: Id;
  username: string;
  displayName: string;
  nickname: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  statusText: string | null;
  isBot: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  email: string | null;
  emailVerified: boolean;
  createdAt: string | null;
}

export interface InstanceInfo {
  instanceId: string | null;
  name: string;
  description: string;
  version: string | null;
  apiVersion: string | null;
  protocolVersion: string | null;
  registration: {
    enabled: boolean;
    approvalRequired: boolean;
    emailVerificationRequired: boolean;
  };
}

export interface LegalInfo {
  termsVersion: string;
  privacyVersion: string;
  updated: string | null;
}

export interface Community {
  id: Id;
  name: string;
  description: string | null;
  slug: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  isOwner: boolean;
  memberCount: number | null;
  unreadCount: number;
  position: number;
  permissions: string[];
}

export interface Channel {
  id: Id;
  serverId: Id | null;
  name: string;
  type: string;
  topic: string | null;
  position: number;
  categoryId: Id | null;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface ChannelCategory {
  id: Id;
  name: string;
  position: number;
}

export interface ChannelTree {
  categories: ChannelCategory[];
  channels: Channel[];
}

export interface Attachment {
  id: Id;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  url: string | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface Message {
  id: Id;
  seq: number | null;
  content: string;
  createdAt: string | null;
  editedAt: string | null;
  authorId: Id | null;
  authorName: string | null;
  authorDisplay: string | null;
  authorAvatar: string | null;
  replyCount: number;
  attachments: Attachment[];
  reactions: Reaction[];
  embeds: MessageEmbed[];
  pinned: boolean;
}

export interface MessageEmbed {
  url: string | null;
  title: string | null;
  description: string | null;
}

export interface Conversation {
  id: Id;
  peer: User | null;
  lastMessageAt: string | null;
  unreadCount: number;
  messages: Message[];
}

export interface Member {
  user: User;
  role: string | null;
  joinedAt: string | null;
}

export interface NotificationItem {
  id: Id;
  type: string;
  createdAt: string | null;
  readAt: string | null;
  referenceId: string | null;
  actor: User | null;
}

export interface NotificationPage {
  items: NotificationItem[];
  unreadCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface DeviceSession {
  jti: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface PrivacySettings {
  allowDmsFrom: 'anyone' | 'friends' | 'nobody';
  allowFriendRequests: 'anyone' | 'friends' | 'nobody';
  showOnline: boolean;
  showReadReceipts: boolean;
  showProfile: 'everyone' | 'members' | 'nobody';
  allowSearch: boolean;
}

export interface NotificationPrefs {
  notifyOnMention: boolean;
  notifyOnDm: boolean;
  notifyOnFriendRequest: boolean;
  notifyOnReply: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface LoginResult {
  token: string;
  user: RawUser;
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresInSeconds: number;
}

export interface TwoFactorStatus {
  enabled: boolean;
  pending: boolean;
}

export interface InstanceListing {
  name: string;
  url: string;
  description: string | null;
}
