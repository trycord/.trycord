// trycord-botjs
//
// The official SDK for Trycord bots.
//
//     import { Client, Events } from 'trycord-botjs';
//
//     const client = new Client({ token: process.env.TRYCORD_BOT_TOKEN! });
//     client.on(Events.MessageCreated, async (event) => {
//       const message = event.message;
//       if (!message || message.author_is_bot) return;
//       if (message.content === '!ping') {
//         await client.send(event.serverId!, event.channelId!, 'Pong.');
//       }
//     });
//     await client.login();
//
// What is here:
//
//   Client     the object a program makes and keeps
//   REST       the request layer on its own
//   Gateway    the socket an application holds open
//   Events     the event names the server sends
//   the objects: User, Message, Channel, Community
//   the errors: HttpError, ConnectionError, RateLimitError and the rest
//
// Everything here talks to routes the server really has. There is no method
// that reaches an endpoint that does not exist, and no event name that the
// server does not send.

export { Client, DEFAULT_BASE_URL, type ClientOptions } from './client.js';
export { REST, sleep, type RawResponse, type RateLimitInfo, type RequestOptions, type RestOptions } from './rest.js';
export {
  AuthenticationError,
  ConnectionError,
  HttpError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  TrycordError,
  UsageError,
  type ErrorBody,
} from './errors.js';
export {
  ALL_EVENTS,
  Events,
  type ChannelEvent,
  type CommandCreatedEvent,
  type EventActor,
  type EventName,
  type GatewayEnvelope,
  type GatewayEvent,
  type MemberEvent,
  type MessageCreatedEvent,
  type RoleEvent,
} from './events.js';
export {
  Gateway,
  type GatewayOptions,
  type GatewayState,
  type SocketLike,
  type Ticket,
} from './gateway.js';
export {
  ChannelObject,
  CommunityObject,
  MessageObject,
  UserObject,
  avatarUrlOf,
  displayNameOf,
  fetchChannel,
  fetchCommunity,
  isBotOf,
  listApplications,
  listCommands,
  listRoles,
  page,
  sendMessage,
} from './objects.js';
export type {
  Application,
  Attachment,
  Channel,
  Command,
  CommandOption,
  Community,
  Credential,
  Embed,
  Health,
  Member,
  Message,
  Page,
  Reaction,
  Role,
  User,
} from './types.js';
