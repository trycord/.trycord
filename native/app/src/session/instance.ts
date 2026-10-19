/**
 * Which instance the client is talking to.
 *
 * Trycord instances are run independently. A session belongs to the instance
 * that issued it, so the instance's origin is part of the key the token is
 * filed under, and a token for one instance is never presented to another.
 */

import {ApiClient, FetchLike} from '../api/client';
import {InstanceInfo} from '../api/types';
import {endpoints} from '../api';

/** The instance a build talks to when the reader has not chosen one. */
export const DEFAULT_INSTANCE_URL = 'https://api.trycord.dev';

/** The prefix of the key a session is filed under in the keystore. */
export const TOKEN_KEY_PREFIX = 'trycord.session.';

/** Where the chosen instance is remembered. */
export const CURRENT_INSTANCE_KEY = 'trycord.currentInstance';

/** Where the list of instances the reader has used is remembered. */
export const KNOWN_INSTANCES_KEY = 'trycord.knownInstances';

/**
 * Accepts an address only if it is a full http(s) address.
 *
 * A bare hostname is refused on purpose: the client has to know whether it is
 * speaking to a Trycord backend over TLS or to something else over plain
 * HTTP, and guessing is how a bearer token ends up on the wrong host.
 */
export function normalizeInstanceUrl(value: string): string | null {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  if (!/^https?:\/\/[^\s/?#]+/i.test(text)) return null;
  return text;
}

/**
 * The origin of an instance address: the scheme, the host and the port, and
 * nothing else.
 *
 * Two addresses that differ only in their path are the same instance, and
 * share one session.
 */
export function instanceOrigin(value: string): string {
  const text = String(value || '').trim();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/.exec(text);
  if (!match) return text.replace(/\/+$/, '');
  return match[1].replace(/\/+$/, '');
}

/** The keystore key a session for one origin is filed under. */
export function sessionKeyFor(origin: string): string {
  return `${TOKEN_KEY_PREFIX}${origin}`;
}

/** The socket address for a one-use ticket. */
export function realtimeUrl(baseUrl: string, ticket: string): string {
  const base = baseUrl.replace(/^http/i, 'ws');
  return `${base}/?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * A client for an instance, with no session attached.
 *
 * Used for the documents that are public - the instance's own description and
 * the legal versions - and before anyone has signed in.
 */
export function createInstanceClient(url: string): ApiClient {
  const base = normalizeInstanceUrl(url);
  if (!base) {
    throw new Error('That is not a full web address.');
  }
  return new ApiClient({baseUrl: base, token: null});
}

/**
 * Asks an instance who it is.
 *
 * The chooser calls this before it accepts an address, so an address that
 * answers something other than a Trycord backend is refused here rather than
 * at the first sign-in.
 */
export async function probeInstance(
  url: string,
  fetchImpl?: FetchLike,
): Promise<InstanceInfo> {
  const base = normalizeInstanceUrl(url);
  if (!base) {
    throw new Error('Enter a full http(s) address, for example https://api.example.com');
  }
  const client = new ApiClient({
    baseUrl: base,
    token: null,
    fetchImpl,
    timeoutMs: 10000,
  });
  return endpoints.instanceInfo(client);
}
