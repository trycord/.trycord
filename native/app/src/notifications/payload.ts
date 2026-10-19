/**
 * The push payload.
 *
 * A push notification is delivered by someone else's infrastructure - Apple's
 * push service, Google's - and it may be read on a locked screen, logged by
 * an intermediary, or inspected by anyone with access to the device. So the
 * payload carries no message content at all: no text, no author, no preview.
 * What it carries is enough to open the right place, and nothing else.
 *
 * The content is fetched from the server once the app is open and
 * authenticated, which is the only moment it can be shown safely.
 *
 * The rules below are executable rather than aspirational:
 * `assertPrivacySafe` is called by the transport before a payload leaves the
 * device, and it refuses to send a payload that carries a sample of the text
 * it was built from.
 */

export const PUSH_PAYLOAD_VERSION = 1;

export type PushEventType =
  | 'message'
  | 'mention'
  | 'reply'
  | 'friend_request'
  | 'notification';

export type PushScope = 'channel' | 'dm';

export interface PushTarget {
  scope: PushScope;
  communityId: string | null;
  channelId: string | null;
  conversationId: string | null;
  messageId: string | null;
}

/**
 * What travels. Every field is an identifier or a kind. There is no field a
 * message could be written into, and `assertPrivacySafe` checks that.
 */
export interface PushPayload {
  /** The version of this payload format. */
  v: number;
  /** What kind of thing happened. */
  type: PushEventType;
  /** Where it happened. */
  target: PushTarget;
  /**
   * An opaque reference the server issued. The app uses it to ask the server
   * for the thing that happened, once it is signed in.
   */
  ref: string;
}

/** The event the server tells the client about, before it is trimmed down. */
export interface PushEvent {
  type: PushEventType;
  scope: PushScope;
  communityId?: string | null;
  channelId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  referenceId: string;
  /**
   * The text of the message, kept so the privacy check can prove the payload
   * does not carry it. It is never placed in the payload.
   */
  content?: string | null;
}

/**
 * Builds the payload that leaves the device.
 *
 * Nothing from the event survives except the identifiers and the kind.
 */
export function buildPushPayload(event: PushEvent): PushPayload {
  return {
    v: PUSH_PAYLOAD_VERSION,
    type: event.type,
    target: {
      scope: event.scope,
      communityId: event.communityId ?? null,
      channelId: event.channelId ?? null,
      conversationId: event.conversationId ?? null,
      messageId: event.messageId ?? null,
    },
    ref: event.referenceId,
  };
}

/**
 * The text a notification shows, written on the device.
 *
 * These are deliberately generic. A title that named the sender or the
 * channel would say something on a locked screen, which is the thing the
 * payload was built to avoid.
 */
export function pushNotificationTitle(payload: PushPayload): string {
  switch (payload.type) {
    case 'mention':
      return 'You were mentioned';
    case 'reply':
      return 'New reply';
    case 'friend_request':
      return 'New friend request';
    case 'message':
      return 'New message';
    default:
      return 'Trycord';
  }
}

/** The keys a payload must never carry, whatever the version. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'content',
  'body',
  'text',
  'title',
  'message',
  'preview',
  'snippet',
  'author',
  'authorName',
  'sender',
  'displayName',
  'username',
];

/**
 * True when the payload carries a sample of the text it was built from.
 *
 * A sample is the message content, or any part of it long enough to be
 * recognisable. An empty sample cannot be leaked, so it never matches.
 */
export function containsMessageContent(payload: PushPayload, sample: string | null): boolean {
  const text = String(sample || '').trim();
  if (!text) return false;
  const serialised = JSON.stringify(payload);
  return serialised.includes(text) || serialised.includes(escapeForJson(text));
}

function escapeForJson(text: string): string {
  return text.replace(/"/g, '\\"');
}

/**
 * The check the transport runs before a payload leaves the device.
 *
 * It throws when the payload carries a forbidden key, and when it carries the
 * text it was built from. A push that leaks is worse than a push that never
 * arrives.
 */
export function assertPrivacySafe(payload: PushPayload, sample?: string | null): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
      throw new Error(`A push payload must not carry "${key}".`);
    }
  }
  for (const key of Object.keys(payload.target)) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
      throw new Error(`A push payload target must not carry "${key}".`);
    }
  }
  if (containsMessageContent(payload, sample ?? null)) {
    throw new Error('A push payload must not carry the message content.');
  }
}
