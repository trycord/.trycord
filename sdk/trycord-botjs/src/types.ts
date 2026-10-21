// The types the platform speaks.
//
// These are the shapes the server actually sends. Where the server sends two
// spellings of one field - `display_name` and `displayName` - the type says
// so, and the SDK reads both.

/** A person. A bot is a person with `isBot` set. */
export interface User {
  id: string;
  username: string;
  displayName?: string | null;
  display_name?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  bannerUrl?: string | null;
  banner_url?: string | null;
  bio?: string | null;
  statusText?: string | null;
  status_text?: string | null;
  isBot?: boolean;
  is_bot?: boolean;
  createdAt?: string | null;
  created_at?: string | null;
}

/** A community. Trycord calls them servers; the API calls them communities. */
export interface Community {
  id: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  icon_url?: string | null;
  bannerUrl?: string | null;
  banner_url?: string | null;
  isPublic?: boolean;
  is_public?: boolean;
  memberCount?: number;
  member_count?: number;
  channelCount?: number;
  channel_count?: number;
}

/** A channel. */
export interface Channel {
  id: string;
  serverId?: string;
  server_id?: string;
  name: string;
  type: 'text' | 'voice' | 'stage' | 'announcement' | string;
  topic?: string | null;
  categoryId?: string | null;
  category_id?: string | null;
  position?: number;
  slowMode?: number;
  slow_mode?: number;
}

/** A member of a community. */
export interface Member {
  id: string;
  serverId?: string;
  server_id?: string;
  username?: string;
  displayName?: string | null;
  display_name?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  isBot?: boolean;
  is_bot?: boolean;
  isOwner?: boolean;
  is_owner?: boolean;
  joinedAt?: string | null;
  joined_at?: string | null;
  roles?: Array<{ id: string; name: string; color?: string | null }>;
}

/** A file on a message. */
export interface Attachment {
  id: string;
  url?: string;
  filename?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
}

/** A reaction on a message. */
export interface Reaction {
  /** The emoji, as it was written. */
  emoji: string;
  /** How many people gave it. */
  count: number;
  /** Who gave it, when the server said. */
  users?: User[];
  me?: boolean;
}

/** A message in a channel. */
export interface Message {
  id: string;
  channelId?: string;
  channel_id?: string;
  serverId?: string;
  server_id?: string;
  authorId?: string;
  author_id?: string;
  authorName?: string;
  author_name?: string;
  authorDisplay?: string;
  author_display?: string;
  authorAvatar?: string | null;
  author_avatar?: string | null;
  authorIsBot?: boolean;
  author_is_bot?: boolean;
  content: string;
  createdAt?: string;
  created_at?: string;
  editedAt?: string | null;
  edited_at?: string | null;
  seq?: number | null;
  replyCount?: number;
  reply_count?: number;
  threadRootId?: string | null;
  thread_root_id?: string | null;
  pinned?: boolean;
  attachments?: Attachment[];
  embeds?: Embed[];
  reactions?: Reaction[];
  pending?: boolean;
  encrypted?: boolean;
  unreadable?: boolean;
}

/** A link preview. */
export interface Embed {
  url: string;
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  site_name?: string | null;
  imageUrl?: string | null;
  image_url?: string | null;
  videoUrl?: string | null;
  video_url?: string | null;
  status?: 'ok' | 'unavailable' | string;
}

/** A role in a community. */
export interface Role {
  id: string;
  name: string;
  color?: string | null;
  permissions?: string[];
  position?: number;
}

/** A bot application. */
export interface Application {
  id: string;
  serverId?: string;
  server_id?: string;
  ownerUserId?: string;
  owner_user_id?: string;
  botUserId?: string | null;
  bot_user_id?: string | null;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  icon_url?: string | null;
  status?: 'active' | 'disabled' | string;
  createdAt?: string;
  created_at?: string;
}

/** A credential: the scopes and the limit, never the secret. */
export interface Credential {
  id: string;
  name?: string;
  scopes?: string[];
  kind?: string;
  rateLimitPerMinute?: number;
  rate_limit_per_minute?: number;
}

/** A slash command an application declares. */
export interface Command {
  id: string;
  applicationId?: string;
  application_id?: string;
  name: string;
  description?: string | null;
  response?: string | null;
  options?: CommandOption[];
}

/** One argument of a command. */
export interface CommandOption {
  name: string;
  type: 'string' | 'integer' | 'boolean' | string;
  required?: boolean;
  description?: string | null;
  default?: unknown;
}

/** A page of results, as the server sends it. */
export interface Page<T> {
  items: T[];
  total?: number;
  hasMore?: boolean;
  has_more?: boolean;
  limit?: number;
  offset?: number;
}

/** The answer to a health check. */
export interface Health {
  ok?: boolean;
  status?: string;
  detail?: string;
  checkedAt?: string;
  checked_at?: string;
}
