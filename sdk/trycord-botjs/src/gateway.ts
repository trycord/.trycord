// The application gateway.
//
// An application that can post and cannot hear anything is a mail-merge. The
// gateway is the socket an application holds open to receive the events of
// its community.
//
// The handshake is the shape the server speaks:
//
//   1. ask for a ticket   POST /api/v1/applications/:id/gateway-ticket
//   2. open the socket    ?application=<id>&ticket=<ticket>
//   3. say what to hear   {"op":"subscribe","events":[...]}
//
// The token never rides in a URL: a URL ends up in access logs, proxy logs
// and referrer headers. The ticket is spent the moment it is used, and it
// is good for a minute.
//
// The guarantees are the ones the server gives, and no more: an event is
// delivered while the socket is open. Nothing is replayed, and nothing is
// queued for a socket that was closed.

import { ConnectionError, UsageError } from './errors.js';
import { ALL_EVENTS, type EventName, type GatewayEnvelope } from './events.js';
import type { REST } from './rest.js';
import { sleep } from './rest.js';

const SUBSCRIPTION_TIMEOUT_MS = 10_000;

interface SubscriptionWaiter {
  resolve: (events: string[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The answer to a ticket request. */
export interface Ticket {
  ticket: string;
  expiresInMs?: number;
  url?: string;
}

/** The socket the gateway speaks. Anything with the WebSocket shape works. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  readyState?: number;
}

/** How the gateway should behave. */
export interface GatewayOptions {
  /** The instance's address, e.g. `https://trycord.dev`. */
  baseUrl: string;
  /** The application's id. */
  applicationId: string;
  /** The events to hear. */
  events?: EventName[];
  /** How long to wait between heartbeats. Thirty seconds by default. */
  heartbeatMs?: number;
  /** How many times to reconnect before giving up. Five by default. */
  maxReconnects?: number;
  /** The socket to use. The global one by default. */
  createSocket?: (url: string) => SocketLike;
  /** Called for every frame, for debugging. */
  onDebug?: (line: string) => void;
}

/** What the gateway is doing. */
export type GatewayState = 'closed' | 'connecting' | 'open' | 'reconnecting';

/**
 * The gateway.
 *
 * It opens the socket, says what the application wants to hear, and hands
 * the frames to the client. A socket that drops is reopened, with a pause
 * that grows, and after a few tries the gateway gives up and says so.
 */
export class Gateway {
  readonly applicationId: string;

  private readonly rest: REST;
  private readonly options: GatewayOptions;
  private socket: SocketLike | null = null;
  private state: GatewayState = 'closed';
  private stopped = false;
  private attempts = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handler: ((event: GatewayEnvelope) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private stateHandler: ((state: GatewayState) => void) | null = null;
  private acceptedSubscriptions: EventName[] | null = null;
  private pendingSubscriptions: SubscriptionWaiter[] = [];

  constructor(rest: REST, options: GatewayOptions) {
    this.rest = rest;
    this.options = options;
    this.applicationId = options.applicationId;
  }

  /** What the gateway is doing. */
  get status(): GatewayState {
    return this.state;
  }

  /** The events this connection has asked for. */
  get subscriptions(): EventName[] {
    if (this.acceptedSubscriptions) return [...this.acceptedSubscriptions];
    return this.options.events ? [...this.options.events] : [...ALL_EVENTS];
  }

  /** Called for every event frame. */
  onEvent(handler: (event: GatewayEnvelope) => void): this {
    this.handler = handler;
    return this;
  }

  /** Called when the gateway cannot go on. */
  onError(handler: (error: Error) => void): this {
    this.errorHandler = handler;
    return this;
  }

  /** Called when the state changes. */
  onState(handler: (state: GatewayState) => void): this {
    this.stateHandler = handler;
    return this;
  }

  /**
   * Open the socket.
   *
   * It resolves when the server confirms the event subscription.
   */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.open();
  }

  /** Close the socket, and stop reconnecting. */
  close(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.failPendingSubscriptions(new ConnectionError('The gateway closed before confirming its subscription.'));
    if (this.socket) {
      try {
        this.socket.close(1000, 'the application closed the gateway');
      } catch {
        /* the socket is already gone */
      }
    }
    this.socket = null;
    this.setState('closed');
  }

  /** Say which events to hear and return the list the server accepted. */
  async subscribe(events?: EventName[]): Promise<string[]> {
    if (!this.socket) throw new UsageError('The gateway is not open.');
    const wanted = [...new Set(events === undefined ? this.subscriptions : events)];
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.pendingSubscriptions.indexOf(waiter);
        if (at !== -1) this.pendingSubscriptions.splice(at, 1);
        reject(new ConnectionError('The gateway did not confirm its event subscription.'));
      }, SUBSCRIPTION_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = { resolve, reject, timer };
      this.pendingSubscriptions.push(waiter);
      try {
        this.socket!.send(JSON.stringify({ op: 'subscribe', events: wanted }));
      } catch (error) {
        const at = this.pendingSubscriptions.indexOf(waiter);
        if (at !== -1) this.pendingSubscriptions.splice(at, 1);
        clearTimeout(timer);
        reject(new ConnectionError('The gateway could not send its event subscription.', error));
      }
    });
  }

  private async open(): Promise<void> {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const ticket = await this.rest.request<Ticket>({
      method: 'POST',
      path: `/applications/${encodeURIComponent(this.applicationId)}/gateway-ticket`,
    });
    if (!ticket || !ticket.ticket) {
      throw new ConnectionError('The instance did not give the application a ticket.');
    }

    const url = this.socketUrl(ticket.ticket);
    const socket = this.createSocket(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.onopen = null;
        socket.onerror = null;
        resolve();
      };
      const onError = (event: unknown) => {
        socket.onopen = null;
        socket.onerror = null;
        reject(new ConnectionError('The gateway socket could not be opened.', event));
      };
      socket.onopen = onOpen;
      socket.onerror = onError;
    });

    this.attempts = 0;

    socket.onmessage = (event) => this.onMessage(event);
    socket.onclose = () => this.onClose();
    socket.onerror = () => { /* the close handler deals with it */ };

    await this.subscribe();
    this.setState('open');
    this.startHeartbeat();
  }

  private socketUrl(ticket: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const ws = base.startsWith('https://') ? 'wss://' : 'ws://';
    const path = '/api/v1/gateway';
    return `${ws}${base.replace(/^https?:\/\//, '')}${path}`
      + `?application=${encodeURIComponent(this.applicationId)}`
      + `&ticket=${encodeURIComponent(ticket)}`;
  }

  private createSocket(url: string): SocketLike {
    if (this.options.createSocket) return this.options.createSocket(url);
    const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
    if (!Ctor) {
      throw new UsageError(
        'This runtime has no WebSocket. Node 22 has one; on an older runtime, '
        + 'pass a createSocket that returns one.',
      );
    }
    return new Ctor(url);
  }

  private onMessage(event: { data: unknown }): void {
    let frame: GatewayEnvelope;
    try {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      frame = JSON.parse(text) as GatewayEnvelope;
    } catch {
      return;
    }
    this.debug(`a frame: ${frame && frame.event ? frame.event : (frame && frame.op) || 'unknown'}`);
    // The subscription answer and the heartbeat answer are not events.
    if (frame && frame.op === 'subscribed') {
      this.receiveSubscription(frame);
      return;
    }
    if (frame && (frame.op === 'pong' || frame.op === 'ping')) return;
    if (frame && typeof frame.event === 'string' && this.handler) {
      try {
        this.handler(frame);
      } catch (error) {
        // A listener that throws is the caller's problem, and it must not
        // take the socket down with it.
        this.report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private onClose(): void {
    this.clearHeartbeat();
    this.failPendingSubscriptions(new ConnectionError('The gateway closed before confirming its event subscription.'));
    if (this.stopped) {
      this.setState('closed');
      return;
    }
    this.setState('reconnecting');
    if (this.attempts >= (this.options.maxReconnects ?? 5)) {
      this.report(new ConnectionError('The gateway could not stay open.'));
      this.setState('closed');
      return;
    }
    this.attempts += 1;
    const pause = Math.min(1000 * this.attempts, 15_000);
    this.debug(`the socket closed; trying again in ${pause}ms`);
    setTimeout(() => {
      if (this.stopped) return;
      this.open().catch((error) => this.report(error));
    }, pause);
  }

  private receiveSubscription(frame: GatewayEnvelope): void {
    const accepted = Array.isArray(frame.events)
      ? frame.events.filter((event): event is EventName => ALL_EVENTS.includes(event as EventName))
      : [];
    this.acceptedSubscriptions = accepted;
    const waiter = this.pendingSubscriptions.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve([...accepted]);
  }

  private failPendingSubscriptions(error: Error): void {
    for (const waiter of this.pendingSubscriptions.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const every = this.options.heartbeatMs ?? 30_000;
    this.heartbeat = setInterval(() => {
      if (!this.socket) return;
      try {
        this.socket.send(JSON.stringify({ op: 'ping' }));
      } catch {
        /* the close handler deals with it */
      }
    }, every);
    // A heartbeat must not keep the process alive on its own.
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private setState(state: GatewayState): void {
    if (this.state === state) return;
    this.state = state;
    if (this.stateHandler) this.stateHandler(state);
  }

  private report(error: Error): void {
    if (this.errorHandler) this.errorHandler(error);
    else this.debug(error.message);
  }

  private debug(line: string): void {
    if (this.options.onDebug) this.options.onDebug(line);
  }
}

/** Wait, without blocking the thread. */
export { sleep };
