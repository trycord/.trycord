// The core objects.
//
// Small wrappers around the server's own shapes. They exist to make the
// common things one line long - a message replies, a community lists its
// members - and to hide the two spellings the server uses for one field.
//
// A wrapper never invents data: everything it shows came from the server,
// and a field the server did not send is null rather than guessed.

import type { REST } from './rest.js';
import type {
  Application,
  Channel,
  Command,
  Community,
  Credential,
  Health,
  Member,
  Message,
  Page,
  Role,
  User,
} from './types.js';

/** The name a person is shown by. */
export function displayNameOf(user: {
  nickname?: string | null;
  displayName?: string | null;
  display_name?: string | null;
  username?: string | null;
} | null | undefined): string {
  if (!user) return 'Unknown';
  return user.nickname || user.displayName || user.display_name || user.username || 'Unknown';
}

/** The picture a person is shown by. */
export function avatarUrlOf(user: {
  avatarUrl?: string | null;
  avatar_url?: string | null;
} | null | undefined): string | null {
  if (!user) return null;
  return user.avatarUrl || user.avatar_url || null;
}

/** Whether a person is a bot. */
export function isBotOf(user: { isBot?: boolean; is_bot?: boolean } | null | undefined): boolean {
  return !!(user && (user.isBot || user.is_bot));
}

/** A person. */
export class UserObject implements User {
  readonly id: string;
  readonly username: string;
  readonly displayName?: string | null;
  readonly display_name?: string | null;
  readonly nickname?: string | null;
  readonly avatarUrl?: string | null;
  readonly avatar_url?: string | null;
  readonly isBot?: boolean;
  readonly is_bot?: boolean;
  readonly raw: User;

  constructor(raw: User) {
    this.raw = raw;
    this.id = raw.id;
    this.username = raw.username;
    this.displayName = raw.displayName;
    this.display_name = raw.display_name;
    this.nickname = raw.nickname;
    this.avatarUrl = raw.avatarUrl;
    this.avatar_url = raw.avatar_url;
    this.isBot = raw.isBot;
    this.is_bot = raw.is_bot;
  }

  /** The name this person is shown by. */
  get name(): string {
    return displayNameOf(this);
  }

  /** Whether this person is a bot. */
  get bot(): boolean {
    return isBotOf(this);
  }

  /** The picture, when there is one. */
  get picture(): string | null {
    return avatarUrlOf(this);
  }
}

/** A message. */
export class MessageObject implements Message {
  readonly id: string;
  readonly channelId?: string;
  readonly channel_id?: string;
  readonly serverId?: string;
  readonly server_id?: string;
  readonly authorId?: string;
  readonly author_id?: string;
  readonly content: string;
  readonly createdAt?: string;
  readonly created_at?: string;
  readonly editedAt?: string | null;
  readonly replyCount?: number;
  readonly reply_count?: number;
  readonly threadRootId?: string | null;
  readonly pinned?: boolean;
  readonly attachments?: Message['attachments'];
  readonly embeds?: Message['embeds'];
  readonly reactions?: Message['reactions'];
  readonly raw: Message;

  private readonly rest: REST;

  constructor(raw: Message, rest: REST) {
    this.raw = raw;
    this.rest = rest;
    this.id = raw.id;
    this.channelId = raw.channelId;
    this.channel_id = raw.channel_id;
    this.serverId = raw.serverId;
    this.server_id = raw.server_id;
    this.authorId = raw.authorId;
    this.author_id = raw.author_id;
    this.content = raw.content;
    this.createdAt = raw.createdAt;
    this.created_at = raw.created_at;
    this.editedAt = raw.editedAt;
    this.replyCount = raw.replyCount;
    this.reply_count = raw.reply_count;
    this.threadRootId = raw.threadRootId;
    this.pinned = raw.pinned;
    this.attachments = raw.attachments;
    this.embeds = raw.embeds;
    this.reactions = raw.reactions;
  }

  /** The community this message is in. */
  get communityId(): string | undefined {
    return this.serverId || this.server_id;
  }

  /** The channel this message is in. */
  get channel(): string | undefined {
    return this.channelId || this.channel_id;
  }

  /** The name of whoever wrote it. */
  get authorName(): string {
    return this.raw.authorName || this.raw.author_name || this.raw.authorDisplay || this.raw.author_display || 'Unknown';
  }

  /** Whether a bot wrote it. */
  get authorIsBot(): boolean {
    return !!(this.raw.authorIsBot || this.raw.author_is_bot);
  }

  /**
   * Write a message in the same channel.
   *
   * @param content What to write.
   */
  async reply(content: string): Promise<MessageObject> {
    const community = this.communityId;
    const channel = this.channel;
    if (!community || !channel) {
      throw new Error('This message does not say which channel it is in.');
    }
    return sendMessage(this.rest, community, channel, content);
  }
}

/** A community. */
export class CommunityObject implements Community {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly iconUrl?: string | null;
  readonly icon_url?: string | null;
  readonly bannerUrl?: string | null;
  readonly banner_url?: string | null;
  readonly isPublic?: boolean;
  readonly is_public?: boolean;
  readonly raw: Community;

  private readonly rest: REST;

  constructor(raw: Community, rest: REST) {
    this.raw = raw;
    this.rest = rest;
    this.id = raw.id;
    this.name = raw.name;
    this.description = raw.description;
    this.iconUrl = raw.iconUrl;
    this.icon_url = raw.icon_url;
    this.bannerUrl = raw.bannerUrl;
    this.banner_url = raw.banner_url;
    this.isPublic = raw.isPublic;
    this.is_public = raw.is_public;
  }

  /** The members of this community. */
  async members(options: { limit?: number; offset?: number } = {}): Promise<Member[]> {
    const data = await this.rest.request<{ members?: Member[] } | Member[]>({
      path: `/communities/${encodeURIComponent(this.id)}/members`,
      query: { limit: options.limit, offset: options.offset },
    });
    return Array.isArray(data) ? data : (data.members || []);
  }

  /** The applications of this community. */
  async applications(): Promise<Application[]> {
    const data = await this.rest.request<{ applications?: Application[] } | Application[]>({
      path: `/communities/${encodeURIComponent(this.id)}/applications`,
    });
    return Array.isArray(data) ? data : (data.applications || []);
  }
}

/** A channel. */
export class ChannelObject implements Channel {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly topic?: string | null;
  readonly serverId?: string;
  readonly server_id?: string;
  readonly raw: Channel;

  private readonly rest: REST;

  constructor(raw: Channel, rest: REST) {
    this.raw = raw;
    this.rest = rest;
    this.id = raw.id;
    this.name = raw.name;
    this.type = raw.type;
    this.topic = raw.topic;
    this.serverId = raw.serverId;
    this.server_id = raw.server_id;
  }

  /** The community this channel is in. */
  get communityId(): string | undefined {
    return this.serverId || this.server_id;
  }

  /**
   * Write a message in this channel.
   *
   * @param content What to write.
   */
  async send(content: string): Promise<MessageObject> {
    const community = this.communityId;
    if (!community) throw new Error('This channel does not say which community it is in.');
    return sendMessage(this.rest, community, this.id, content);
  }

  /**
   * The recent messages of this channel.
   *
   * @param options How many, and from where.
   */
  async messages(options: { limit?: number } = {}): Promise<MessageObject[]> {
    const community = this.communityId;
    if (!community) throw new Error('This channel does not say which community it is in.');
    const data = await this.rest.request<{ messages?: Message[] } | Message[]>({
      path: `/communities/${encodeURIComponent(community)}/channels/${encodeURIComponent(this.id)}/messages`,
      query: { limit: options.limit },
    });
    const rows = Array.isArray(data) ? data : (data.messages || []);
    return rows.map((row) => new MessageObject(row, this.rest));
  }
}

/** Post a message as the application. */
export async function sendMessage(
  rest: REST,
  communityId: string,
  channelId: string,
  content: string,
): Promise<MessageObject> {
  const message = await rest.request<Message>({
    method: 'POST',
    path: `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages`,
    body: { content },
  });
  return new MessageObject(message, rest);
}

/** Read a community. */
export async function fetchCommunity(rest: REST, communityId: string): Promise<CommunityObject> {
  const community = await rest.request<Community>({
    path: `/communities/${encodeURIComponent(communityId)}`,
  });
  return new CommunityObject(community, rest);
}

/** Read a channel. */
export async function fetchChannel(rest: REST, communityId: string, channelId: string): Promise<ChannelObject> {
  const channel = await rest.request<Channel>({
    path: `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}`,
  });
  return new ChannelObject(channel, rest);
}

/** The applications of a community. */
export async function listApplications(rest: REST, communityId: string): Promise<Application[]> {
  const data = await rest.request<{ applications?: Application[] } | Application[]>({
    path: `/communities/${encodeURIComponent(communityId)}/applications`,
  });
  return Array.isArray(data) ? data : (data.applications || []);
}

/** The commands an application declares. */
export async function listCommands(rest: REST, applicationId: string): Promise<Command[]> {
  const data = await rest.request<{ commands?: Command[] } | Command[]>({
    path: `/applications/${encodeURIComponent(applicationId)}/commands`,
  });
  return Array.isArray(data) ? data : (data.commands || []);
}

/** The credential of an application. */
export async function fetchCredential(rest: REST, applicationId: string): Promise<Credential | null> {
  const data = await rest.request<{ credential?: Credential } | Credential>({
    path: `/applications/${encodeURIComponent(applicationId)}/credential`,
  });
  if (data && typeof data === 'object' && 'credential' in data) return (data as { credential: Credential }).credential;
  return (data as Credential) || null;
}

/** The health of an application. */
export async function fetchHealth(rest: REST, applicationId: string): Promise<Health> {
  return rest.request<Health>({
    path: `/applications/${encodeURIComponent(applicationId)}/health`,
  });
}

/** The roles of a community. */
export async function listRoles(rest: REST, communityId: string): Promise<Role[]> {
  const data = await rest.request<{ roles?: Role[] } | Role[]>({
    path: `/communities/${encodeURIComponent(communityId)}/roles`,
  });
  return Array.isArray(data) ? data : (data.roles || []);
}

/** A page of results. */
export function page<T>(items: T[], total?: number): Page<T> {
  return { items, total };
}
