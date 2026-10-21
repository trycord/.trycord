// The events an application can hear.
//
// The names are the ones the server sends: the same names the webhooks are
// handed, from the same dispatch, so an application and a webhook cannot
// see different events.
//
// The frame is the webhook's envelope, spread as it arrives:
//
//   { v, event, id, at, instance, serverId, channelId, actor, ...payload }
//
// A connection that has not said which events it wants hears nothing.

import type { Member, Message } from './types.js';

/** The event names the gateway understands. */
export const Events = {
  MessageCreated: 'message.created',
  MemberJoined: 'member.joined',
  MemberLeft: 'member.left',
  ChannelCreated: 'channel.created',
  ChannelDeleted: 'channel.deleted',
  RoleCreated: 'role.created',
  RoleUpdated: 'role.updated',
  RoleDeleted: 'role.deleted',
  CommandCreated: 'command.created',
} as const;

/** The name of an event. */
export type EventName = (typeof Events)[keyof typeof Events];

/** Every event name, for a caller that wants them all. */
export const ALL_EVENTS: EventName[] = Object.values(Events);

/** Who caused the event. */
export interface EventActor {
  id?: string;
  /** 'user' or 'bot'. */
  type?: string;
}

/** The envelope every event arrives in. */
export interface GatewayEnvelope {
  /** The envelope version. */
  v?: number | string;
  /** The name of the event. */
  event?: string;
  /** The event's own id. */
  id?: string;
  /** When it happened. */
  at?: string;
  /** The instance it happened on. */
  instance?: { id?: string | null; name?: string | null };
  /** The community it happened in. */
  serverId?: string | null;
  /** The channel it happened in. */
  channelId?: string | null;
  /** Who caused it. */
  actor?: EventActor | null;
  /** The event's own fields. */
  [key: string]: unknown;
}

/** The payload of `message.created`. */
export interface MessageCreatedEvent extends GatewayEnvelope {
  event: 'message.created';
  message?: Message;
}

/** The payload of `member.joined` and `member.left`. */
export interface MemberEvent extends GatewayEnvelope {
  event: 'member.joined' | 'member.left';
  member?: Member;
  user_id?: string;
}

/** The payload of the channel events. */
export interface ChannelEvent extends GatewayEnvelope {
  event: 'channel.created' | 'channel.deleted';
  channelId?: string | null;
  name?: string;
}

/** The payload of the role events. */
export interface RoleEvent extends GatewayEnvelope {
  event: 'role.created' | 'role.updated' | 'role.deleted';
  roleId?: string;
  name?: string;
  color?: string | null;
}

/** The payload of `command.created`. */
export interface CommandCreatedEvent extends GatewayEnvelope {
  event: 'command.created';
  commandId?: string;
  name?: string;
}

/** Any event the gateway can send. */
export type GatewayEvent =
  | MessageCreatedEvent
  | MemberEvent
  | ChannelEvent
  | RoleEvent
  | CommandCreatedEvent;
