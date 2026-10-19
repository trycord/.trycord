/**
 * Offline drafts.
 *
 * A message written on a train, where there is no signal, must not be lost.
 * The composer writes what has been typed into the draft store as the person
 * types, and the conversation screen reads it back when it opens. The draft
 * is removed only when the message reaches the server.
 *
 * A draft is scoped to one target: a channel or a direct conversation. The
 * scope is part of the key, so the same channel id in two communities cannot
 * collide - and the namespace is part of it too, so a draft written on one
 * instance never appears on another.
 */

import {KeyValueStore} from './localStore';
import {nowMs} from '../util/runtime';

export type DraftScope = 'channel' | 'dm';

export interface Draft {
  scope: DraftScope;
  targetId: string;
  serverId: string | null;
  body: string;
  replyToId: string | null;
  updatedAt: number;
}

export interface DraftStore {
  read(scope: DraftScope, targetId: string): Promise<Draft | null>;
  write(draft: Draft): Promise<Draft>;
  remove(scope: DraftScope, targetId: string): Promise<void>;
  list(): Promise<Draft[]>;
  clear(): Promise<void>;
}

/** The key one draft is filed under. */
export function draftKey(
  scope: DraftScope,
  targetId: string,
  namespace?: string,
): string {
  const prefix = namespace ? `trycord.draft.${namespace}.` : 'trycord.draft.';
  return `${prefix}${scope}.${targetId}`;
}

export interface DraftStoreOptions {
  now?: () => number;
  /** The instance this store belongs to. */
  namespace?: string;
}

export function createDraftStore(
  store: KeyValueStore,
  options: DraftStoreOptions = {},
): DraftStore {
  const clock = options.now ?? nowMs;
  const namespace = options.namespace;
  const indexKey = namespace
    ? `trycord.drafts.v1.${namespace}`
    : 'trycord.drafts.v1';

  const keyFor = (scope: DraftScope, targetId: string) =>
    draftKey(scope, targetId, namespace);

  async function readIndex(): Promise<Record<string, Draft>> {
    const raw = await store.get(indexKey);
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A draft index that cannot be read is a lost draft, not a broken app.
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, Draft>;
  }

  async function writeIndex(index: Record<string, Draft>): Promise<void> {
    await store.set(indexKey, JSON.stringify(index));
  }

  return {
    async read(scope: DraftScope, targetId: string): Promise<Draft | null> {
      const index = await readIndex();
      const found = index[keyFor(scope, targetId)];
      return found ? {...found} : null;
    },

    async write(draft: Draft): Promise<Draft> {
      const stored: Draft = {
        scope: draft.scope,
        targetId: draft.targetId,
        serverId: draft.serverId ?? null,
        body: draft.body,
        replyToId: draft.replyToId ?? null,
        updatedAt: clock(),
      };
      const index = await readIndex();
      index[keyFor(stored.scope, stored.targetId)] = stored;
      await writeIndex(index);
      return {...stored};
    },

    async remove(scope: DraftScope, targetId: string): Promise<void> {
      const key = keyFor(scope, targetId);
      const index = await readIndex();
      if (!(key in index)) return;
      delete index[key];
      await writeIndex(index);
    },

    async list(): Promise<Draft[]> {
      const index = await readIndex();
      return Object.keys(index)
        .sort()
        .map(key => ({...index[key]}));
    },

    async clear(): Promise<void> {
      await store.remove(indexKey);
    },
  };
}
