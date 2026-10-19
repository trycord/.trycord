/**
 * The realtime gateway.
 *
 * The socket authenticates with a one-use ticket, because the handshake
 * cannot carry an Authorization header, and it is the only place the client
 * learns that a message arrived, that someone came online, or that the
 * session changed somewhere else.
 *
 * The wire vocabulary is fixed by the server. The names here match it
 * exactly, because a second spelling of an event is an event that is never
 * delivered.
 */

import {cancelTimer, nowMs, scheduleTimer, TimerHandle} from '../util/runtime';

export const REALTIME_EVENTS = {
  MESSAGE: 'message',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_REACTION: 'message_reaction',
  MESSAGE_EMBEDS: 'message_embeds',
  MESSAGE_PINNED: 'message_pinned',
  MESSAGE_UNPINNED: 'message_unpinned',
  DM_MESSAGE: 'dm:message',
  DM_MESSAGE_UPDATED: 'dm:message_updated',
  DM_MESSAGE_DELETED: 'dm:message_deleted',
  DM_MESSAGE_EMBEDS: 'dm:message_embeds',
  DM_READ: 'dm:read',
  DM_TYPING: 'dm:typing',
  PRESENCE: 'presence',
  NOTIFICATION: 'notification',
} as const;

export type RealtimeStatus = 'offline' | 'connecting' | 'online';

export interface RealtimeFrame {
  type: string;
  [key: string]: unknown;
}

/** The part of a WebSocket this client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RealtimeOptions {
  /** Fetches a one-use ticket for the handshake. */
  ticket: () => Promise<string>;
  /** The socket address for a ticket. */
  urlFor: (ticket: string) => string;
  /** Overrides the platform WebSocket. */
  socketFactory?: WebSocketFactory;
  /** The first reconnect delay, in milliseconds. */
  initialDelayMs?: number;
  /** The largest reconnect delay, in milliseconds. */
  maxDelayMs?: number;
}

const OPEN = 1;

function defaultSocketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as unknown as {
    WebSocket?: new (url: string) => WebSocketLike;
  }).WebSocket;
  if (!ctor) {
    throw new Error('This platform has no WebSocket implementation.');
  }
  return new ctor(url);
}

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectDelay: number;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private stopped = true;
  private joinedServer: string | null = null;
  private joinedChannel: string | null = null;
  private joinedConversation: string | null = null;
  private typingSentAt = 0;
  private currentStatus: RealtimeStatus = 'offline';

  private readonly listeners = new Map<string, Set<(frame: RealtimeFrame) => void>>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();

  constructor(private readonly options: RealtimeOptions) {
    this.initialDelay = options.initialDelayMs ?? 1000;
    this.maxDelay = options.maxDelayMs ?? 15000;
    this.reconnectDelay = this.initialDelay;
  }

  status(): RealtimeStatus {
    return this.currentStatus;
  }

  on(type: string, handler: (frame: RealtimeFrame) => void): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
    return () => {
      this.listeners.get(type)?.delete(handler);
    };
  }

  onStatus(handler: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(handler);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  connect(): void {
    this.stopped = false;
    void this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearReconnect();
    this.joinedServer = null;
    this.joinedChannel = null;
    this.joinedConversation = null;
    if (this.socket) {
      try {
        this.socket.close(1000, 'signed out');
      } catch {
        // The socket is already gone.
      }
      this.socket = null;
    }
    this.setStatus('offline');
  }

  joinServer(serverId: string): void {
    this.joinedServer = serverId;
    this.send({type: 'join-server', serverId});
  }

  leaveServer(): void {
    this.joinedServer = null;
    this.send({type: 'leave-server'});
  }

  joinChannel(channelId: string): void {
    this.joinedChannel = channelId;
    this.send({type: 'join', channelId});
  }

  leaveChannel(): void {
    this.joinedChannel = null;
  }

  joinConversation(conversationId: string): void {
    if (this.joinedConversation && this.joinedConversation !== conversationId) {
      this.send({type: 'dm:leave', conversationId: this.joinedConversation});
    }
    this.joinedConversation = conversationId;
    this.send({type: 'dm:join', conversationId});
  }

  leaveConversation(): void {
    if (this.joinedConversation) {
      this.send({type: 'dm:leave', conversationId: this.joinedConversation});
    }
    this.joinedConversation = null;
  }

  /**
   * Says the person is typing.
   *
   * The server throttles nothing for typing, so the client does: one frame
   * every few seconds while the writer keeps going.
   */
  typing(conversationId: string): void {
    const now = nowMs();
    if (now - this.typingSentAt < 3000) return;
    this.typingSentAt = now;
    this.send({type: 'dm:typing', conversationId});
  }

  private setStatus(next: RealtimeStatus): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    for (const handler of Array.from(this.statusListeners)) {
      handler(next);
    }
  }

  private emit(type: string, frame: RealtimeFrame): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of Array.from(set)) {
      handler(frame);
    }
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // The close handler resynchronises.
    }
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    cancelTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), this.maxDelay);
    this.reconnectTimer = scheduleTimer(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private async open(): Promise<void> {
    this.clearReconnect();
    if (this.stopped) return;
    if (this.socket) return;

    this.setStatus('connecting');

    let ticket: string;
    try {
      ticket = await this.options.ticket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    if (!ticket) {
      this.scheduleReconnect();
      return;
    }

    let socket: WebSocketLike;
    try {
      const factory = this.options.socketFactory ?? defaultSocketFactory;
      socket = factory(this.options.urlFor(ticket));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = this.initialDelay;
      this.setStatus('online');
      if (this.joinedServer) this.send({type: 'join-server', serverId: this.joinedServer});
      if (this.joinedChannel) this.send({type: 'join', channelId: this.joinedChannel});
      if (this.joinedConversation) {
        this.send({type: 'dm:join', conversationId: this.joinedConversation});
      }
      this.emit('open', {type: 'open'});
    };

    socket.onmessage = event => {
      let frame: RealtimeFrame;
      try {
        const data = typeof event.data === 'string' ? event.data : '';
        frame = JSON.parse(data) as RealtimeFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      this.emit(frame.type, frame);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setStatus('offline');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // A close always follows an error; the close handler does the work.
    };
  }
}
