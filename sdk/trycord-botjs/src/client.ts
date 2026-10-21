// The client.
//
// One object a program makes and keeps: it holds the token, the REST client
// and the gateway, and it is where the events are handled.
//
//     const client = new Client({ token: process.env.TRYCORD_BOT_TOKEN });
//     client.on(Events.MessageCreated, (event) => { ... });
//     await client.login();
//
// `login` is the name it has because that is what it reads like. What it
// does is open the gateway and say which events the program wants.

import { Events, type EventName, type GatewayEnvelope } from './events.js';
import { Gateway, type GatewayOptions } from './gateway.js';
import { UsageError } from './errors.js';
import {
  ChannelObject,
  CommunityObject,
  MessageObject,
  fetchChannel,
  fetchCommunity,
  listApplications,
  listCommands,
  listRoles,
  sendMessage,
} from './objects.js';
import { REST, type RestOptions } from './rest.js';
import type {
  Application,
  Channel,
  Command,
  CommandOption,
  Community,
  Health,
  Member,
  Message,
  Role,
} from './types.js';

/** How the client is set up. */
export interface ClientOptions {
  /**
   * The instance's address.
   *
   * A self-hosted instance is addressed by its own name, so this is the one
   * thing a program must be told. `https://trycord.dev` is the default.
   */
  baseUrl?: string;
  /** The application's token. */
  token?: string;
  /** The application's id, when it is known. The gateway needs it. */
  applicationId?: string;
  /** The events to hear. Every event by default. */
  events?: EventName[];
  /** How long a request may take. */
  timeoutMs?: number;
  /** How many times a retryable request may be repeated. */
  maxRetries?: number;
  /** A hook for debugging. Nothing secret is ever given to it. */
  onDebug?: (line: string) => void;
  /** The socket the gateway opens. The global one by default. */
  createSocket?: GatewayOptions['createSocket'];
}

type Listener = (event: GatewayEnvelope) => void | Promise<void>;

/** The default instance address. */
export const DEFAULT_BASE_URL = 'https://trycord.dev';

/**
 * The client.
 *
 * It is safe to make more than one: each has its own token, its own
 * connections and its own listeners.
 */
export class Client {
  /** The REST client, for a program that wants the raw surface. */
  readonly rest: REST;

  private readonly options: ClientOptions;
  private readonly listeners = new Map<string, Set<Listener>>();
  private gateway: Gateway | null = null;
  private ready = false;

  constructor(options: ClientOptions = {}) {
    this.options = options;
    const base = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.rest = new REST({
      baseUrl: `${base}/api/v1`,
      token: options.token,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      onDebug: options.onDebug,
    } as RestOptions);
  }

  /** Whether the gateway is open. */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Listen for an event.
   *
   * @param event The event name, e.g. `Events.MessageCreated`.
   * @param listener What to do when it happens.
   */
  on(event: EventName | string, listener: Listener): this {
    const set = this.listeners.get(event) || new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  /**
   * Stop listening for an event.
   *
   * @param event The event name.
   * @param listener The listener to remove. Every listener is removed when
   *   it is left out.
   */
  off(event: EventName | string, listener?: Listener): this {
    if (!listener) {
      this.listeners.delete(event);
      return this;
    }
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /**
   * Open the gateway and start listening.
   *
   * The application's id is needed for the handshake. It is taken from the
   * options, or asked of the server when the token names an application.
   */
  async login(): Promise<void> {
    if (this.ready) return;
    const applicationId = this.options.applicationId || (await this.findApplicationId());
    if (!applicationId) {
      throw new UsageError(
        'The SDK needs the application\'s id to open the gateway. '
        + 'Pass applicationId, or give the client a token that names one.',
      );
    }
    const base = (this.options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.gateway = new Gateway(this.rest, {
      baseUrl: base,
      applicationId,
      events: this.options.events,
      createSocket: this.options.createSocket,
      onDebug: this.options.onDebug,
    });
    this.gateway.onEvent((event) => this.dispatch(event));
    this.gateway.onState((state) => {
      this.ready = state === 'open';
    });
    this.gateway.onError((error) => {
      this.options.onDebug?.(`the gateway: ${error.message}`);
    });
    await this.gateway.connect();
  }

  /** Close the gateway. */
  async logout(): Promise<void> {
    if (this.gateway) this.gateway.close();
    this.gateway = null;
    this.ready = false;
  }

  /**
   * Wait for the first event, or for the timeout.
   *
   * A program that wants to know the bot is alive before it says anything
   * uses this.
   *
   * @param timeoutMs How long to wait. Ten seconds by default.
   */
  async waitForReady(timeoutMs = 10_000): Promise<boolean> {
    const started = Date.now();
    while (!this.ready) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  /**
   * The communities the application belongs to.
   *
   * The server has no "my communities" route for an application, so the
   * application is asked for its own and its community is read.
   */
  async communities(): Promise<CommunityObject[]> {
    const applications = await this.applications();
    const out: CommunityObject[] = [];
    for (const application of applications) {
      const communityId = application.serverId || application.server_id;
      if (!communityId) continue;
      out.push(await this.community(communityId));
    }
    return out;
  }

  /**
   * Read a community.
   *
   * @param communityId The community's id or slug.
   */
  async community(communityId: string): Promise<CommunityObject> {
    return fetchCommunity(this.rest, communityId);
  }

  /**
   * Read a channel.
   *
   * @param communityId The community's id or slug.
   * @param channelId The channel's id or slug.
   */
  async channel(communityId: string, channelId: string): Promise<ChannelObject> {
    return fetchChannel(this.rest, communityId, channelId);
  }

  /**
   * The members of a community.
   *
   * @param communityId The community's id or slug.
   * @param options How many, and from where.
   */
  async members(communityId: string, options: { limit?: number; offset?: number } = {}): Promise<Member[]> {
    const data = await this.rest.request<{ members?: Member[] } | Member[]>({
      path: `/communities/${encodeURIComponent(communityId)}/members`,
      query: { limit: options.limit, offset: options.offset },
    });
    return Array.isArray(data) ? data : (data.members || []);
  }

  /**
   * The roles of a community.
   *
   * @param communityId The community's id or slug.
   */
  async roles(communityId: string): Promise<Role[]> {
    return listRoles(this.rest, communityId);
  }

  /**
   * The applications of a community.
   *
   * @param communityId The community's id or slug.
   */
  async applications(communityId?: string): Promise<Application[]> {
    const id = communityId || (await this.findApplicationId());
    if (!id) return [];
    // The list is per community, so the application's own community is used
    // when the caller did not name one.
    const community = communityId || (await this.applicationCommunityId());
    if (!community) return [];
    return listApplications(this.rest, community);
  }

  /**
   * The commands the application declares.
   *
   * @param applicationId The application's id. The application's own by
   *   default.
   */
  async commands(applicationId?: string): Promise<Command[]> {
    const id = applicationId || this.options.applicationId || (await this.findApplicationId());
    if (!id) return [];
    return listCommands(this.rest, id);
  }

  /**
   * Declare a command the application answers.
   *
   * The command is a name, a sentence about it, the arguments it takes and
   * the answer it gives. It is declared in the community, so a member sees
   * it there and not here.
   *
   * @param communityId The community's id or slug.
   * @param applicationId The application's id.
   * @param command What to declare.
   */
  async registerCommand(
    communityId: string,
    applicationId: string,
    command: { name: string; description?: string; response: string; options?: CommandOption[] },
  ): Promise<Command> {
    const data = await this.rest.request<{ command?: Command } | Command>({
      method: 'PUT',
      path: `/communities/${encodeURIComponent(communityId)}`
        + `/applications/${encodeURIComponent(applicationId)}/commands`,
      body: command,
    });
    return (data && typeof data === 'object' && 'command' in data
      ? (data as { command: Command }).command
      : data as Command);
  }

  /**
   * Take a command away.
   *
   * @param communityId The community's id or slug.
   * @param applicationId The application's id.
   * @param commandId The command's id.
   */
  async removeCommand(communityId: string, applicationId: string, commandId: string): Promise<void> {
    await this.rest.request({
      method: 'DELETE',
      path: `/communities/${encodeURIComponent(communityId)}`
        + `/applications/${encodeURIComponent(applicationId)}/commands/${encodeURIComponent(commandId)}`,
    });
  }

  /**
   * The health of the application.
   *
   * @param applicationId The application's id.
   */
  async health(applicationId?: string): Promise<Health> {
    const id = applicationId || this.options.applicationId || (await this.findApplicationId());
    if (!id) throw new UsageError('The SDK does not know which application to ask about.');
    return this.rest.request<Health>({ path: `/applications/${encodeURIComponent(id)}/health` });
  }

  /**
   * Write a message in a channel.
   *
   * @param communityId The community's id or slug.
   * @param channelId The channel's id or slug.
   * @param content What to write.
   */
  async send(communityId: string, channelId: string, content: string): Promise<MessageObject> {
    return sendMessage(this.rest, communityId, channelId, content);
  }

  /**
   * The recent messages of a channel.
   *
   * @param communityId The community's id or slug.
   * @param channelId The channel's id or slug.
   * @param options How many.
   */
  async messages(
    communityId: string,
    channelId: string,
    options: { limit?: number } = {},
  ): Promise<MessageObject[]> {
    const data = await this.rest.request<{ messages?: Message[] } | Message[]>({
      path: `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages`,
      query: { limit: options.limit },
    });
    const rows = Array.isArray(data) ? data : (data.messages || []);
    return rows.map((row) => new MessageObject(row, this.rest));
  }

  private async findApplicationId(): Promise<string | null> {
    if (this.options.applicationId) return this.options.applicationId;
    // The token knows the application: the server says so when the client
    // asks who it is.
    const data = await this.rest.request<{ application?: { id?: string }; id?: string }>({
      path: '/applications/self',
      idempotent: true,
    });
    return data?.application?.id || data?.id || null;
  }

  private async applicationCommunityId(): Promise<string | null> {
    const data = await this.rest.request<{ communityId?: string; serverId?: string; server_id?: string }>({
      path: '/applications/self',
      idempotent: true,
    });
    return data?.communityId || data?.serverId || data?.server_id || null;
  }

  private dispatch(event: GatewayEnvelope): void {
    const name = event && event.event ? event.event : '';
    const listeners = this.listeners.get(name);
    if (!listeners || !listeners.size) return;
    for (const listener of listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((error) => {
            this.options.onDebug?.(`a listener for ${name} failed: ${String(error)}`);
          });
        }
      } catch (error) {
        this.options.onDebug?.(`a listener for ${name} failed: ${String(error)}`);
      }
    }
  }
}

export { Events };
export type { EventName, GatewayEnvelope };
export type { Channel, Community, Member, Message };
