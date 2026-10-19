/**
 * Deep links.
 *
 * A link says where to go: a community, a channel, a message, a conversation,
 * a person. The app registers the trycord:// scheme, and the same parser
 * understands the https addresses the web client serves, so a link pasted
 * from either place opens the right place here.
 *
 * The parser is deliberately hand-rolled rather than built on URL: the shapes
 * it accepts are a small, fixed set, and a parser that only accepts those
 * shapes is a parser that cannot be talked into opening something else.
 */

export const DEEP_LINK_SCHEME = 'trycord';

export type DeepLinkTarget =
  | {kind: 'community'; communityRef: string}
  | {kind: 'channel'; communityRef: string; channelId: string; messageId?: string}
  | {kind: 'dm'; conversationId: string; messageId?: string}
  | {kind: 'profile'; userId: string}
  | {kind: 'conversations'}
  | {kind: 'settings'}
  | {kind: 'instances'}
  | {kind: 'resetPassword'; token: string};

interface ParsedLink {
  scheme: string;
  host: string;
  segments: string[];
  query: Record<string, string>;
}

const LINK_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/;

/**
 * Splits a link into its scheme, its path segments and its query.
 *
 * A custom scheme may be written trycord://community/name or
 * trycord:///community/name; both mean the same thing here, so the host is
 * folded into the segments when it is present.
 */
export function parseLink(url: string): ParsedLink | null {
  const text = String(url || '').trim();
  if (!text) return null;
  const match = LINK_PATTERN.exec(text);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const host = decodeSegment(match[2] || '');
  const path = match[3] || '';
  const query = parseQuery(match[4] || '');

  const pathSegments = path
    .split('/')
    .map(decodeSegment)
    .filter(segment => segment.length > 0);

  const segments =
    scheme === DEEP_LINK_SCHEME && host
      ? [host, ...pathSegments]
      : pathSegments;

  return {scheme, host, segments, query};
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const key = decodeSegment(index === -1 ? part : part.slice(0, index));
    const value = index === -1 ? '' : decodeSegment(part.slice(index + 1));
    if (!key) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Reads a link into a place to go, or null when the link is not one of ours.
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  const link = parseLink(url);
  if (!link) return null;
  if (link.scheme === DEEP_LINK_SCHEME) {
    return fromAppSegments(link.segments, link.query);
  }
  if (link.scheme === 'http' || link.scheme === 'https') {
    return fromWebSegments(link.segments, link.query);
  }
  return null;
}

function fromAppSegments(
  segments: string[],
  query: Record<string, string>,
): DeepLinkTarget | null {
  const head = segments[0];
  switch (head) {
    case 'community':
    case 'server': {
      const communityRef = segments[1];
      if (!communityRef) return null;
      if (segments[2] === 'channel' && segments[3]) {
        return {
          kind: 'channel',
          communityRef,
          channelId: segments[3],
          messageId: query.message || undefined,
        };
      }
      return {kind: 'community', communityRef};
    }
    case 'channel': {
      const channelId = segments[1];
      if (!channelId) return null;
      const communityRef = query.community || query.server || query.serverid;
      if (!communityRef) return null;
      return {
        kind: 'channel',
        communityRef,
        channelId,
        messageId: query.message || undefined,
      };
    }
    case 'dm':
    case 'dms':
    case 'conversation': {
      const conversationId = segments[1];
      if (!conversationId) return null;
      return {kind: 'dm', conversationId, messageId: query.message || undefined};
    }
    case 'message': {
      const messageId = segments[1];
      if (!messageId) return null;
      if (query.conversation) {
        return {kind: 'dm', conversationId: query.conversation, messageId};
      }
      const channelId = query.channel;
      const communityRef = query.community || query.server;
      if (!channelId || !communityRef) return null;
      return {kind: 'channel', communityRef, channelId, messageId};
    }
    case 'profile':
    case 'user':
    case 'users': {
      const userId = segments[1];
      if (!userId) return null;
      return {kind: 'profile', userId};
    }
    case 'conversations':
    case 'chats':
    case 'home':
      return {kind: 'conversations'};
    case 'settings':
      return {kind: 'settings'};
    case 'instances':
      return {kind: 'instances'};
    case 'reset': {
      const token = segments[1];
      if (!token) return null;
      return {kind: 'resetPassword', token};
    }
    default:
      return null;
  }
}

/**
 * The addresses the web client serves. A link copied from a browser opens
 * the same place here.
 */
function fromWebSegments(
  segments: string[],
  query: Record<string, string>,
): DeepLinkTarget | null {
  const head = segments[0];
  switch (head) {
    case 'server': {
      const communityRef = segments[1];
      if (!communityRef) return null;
      if (segments[2] === 'channel' && segments[3]) {
        return {
          kind: 'channel',
          communityRef,
          channelId: segments[3],
          messageId: query.message || undefined,
        };
      }
      return {kind: 'community', communityRef};
    }
    case 'c': {
      const communityRef = segments[1];
      if (!communityRef) return null;
      return {kind: 'community', communityRef};
    }
    case 'dms':
    case 'dm': {
      const conversationId = segments[1];
      if (!conversationId) return null;
      return {kind: 'dm', conversationId, messageId: query.message || undefined};
    }
    case 'users':
    case 'user':
    case 'profile': {
      const userId = segments[1];
      if (!userId) return null;
      return {kind: 'profile', userId};
    }
    case 'settings':
      return {kind: 'settings'};
    case 'instances':
      return {kind: 'instances'};
    case 'reset-password': {
      const token = segments[1];
      if (!token) return null;
      return {kind: 'resetPassword', token};
    }
    case 'home':
      return {kind: 'conversations'};
    default:
      return null;
  }
}

/**
 * Writes a place to go as a trycord:// link, for sharing and for the address
 * of a notification.
 */
export function buildDeepLink(target: DeepLinkTarget): string {
  switch (target.kind) {
    case 'community':
      return `${DEEP_LINK_SCHEME}://community/${encodeURIComponent(target.communityRef)}`;
    case 'channel': {
      const base =
        `${DEEP_LINK_SCHEME}://community/${encodeURIComponent(target.communityRef)}` +
        `/channel/${encodeURIComponent(target.channelId)}`;
      return target.messageId
        ? `${base}?message=${encodeURIComponent(target.messageId)}`
        : base;
    }
    case 'dm': {
      const base = `${DEEP_LINK_SCHEME}://dm/${encodeURIComponent(target.conversationId)}`;
      return target.messageId
        ? `${base}?message=${encodeURIComponent(target.messageId)}`
        : base;
    }
    case 'profile':
      return `${DEEP_LINK_SCHEME}://profile/${encodeURIComponent(target.userId)}`;
    case 'conversations':
      return `${DEEP_LINK_SCHEME}://conversations`;
    case 'settings':
      return `${DEEP_LINK_SCHEME}://settings`;
    case 'instances':
      return `${DEEP_LINK_SCHEME}://instances`;
    case 'resetPassword':
      return `${DEEP_LINK_SCHEME}://reset/${encodeURIComponent(target.token)}`;
  }
}
