/**
 * The draft store the application uses.
 *
 * There is one store per instance, because a channel id on one instance and
 * the same channel id on another are different conversations and their
 * drafts are different drafts.
 */

import {asyncStorageStore} from './asyncStorage';
import {createDraftStore, DraftStore} from './drafts';

const stores = new Map<string, DraftStore>();

export function draftStoreFor(instanceOrigin: string): DraftStore {
  const existing = stores.get(instanceOrigin);
  if (existing) return existing;
  const created = createDraftStore(asyncStorageStore, {namespace: instanceOrigin});
  stores.set(instanceOrigin, created);
  return created;
}
