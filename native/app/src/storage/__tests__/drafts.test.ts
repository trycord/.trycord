/**
 * The draft store.
 *
 * A message written without a connection must not be lost, and a draft
 * written on one instance must not turn up on another.
 */

import {createMemoryStore} from '../localStore';
import {createDraftStore, draftKey, Draft} from '../drafts';

function draft(scope: Draft['scope'], targetId: string, body: string): Draft {
  return {scope, targetId, serverId: null, body, replyToId: null, updatedAt: 0};
}

describe('the draft store', () => {
  it('keeps what was written and gives it back', async () => {
    const store = createMemoryStore();
    const drafts = createDraftStore(store, {now: () => 1000});

    await drafts.write(draft('channel', 'c1', 'half a thought'));

    const found = await drafts.read('channel', 'c1');
    expect(found).not.toBeNull();
    expect(found?.body).toBe('half a thought');
    expect(found?.updatedAt).toBe(1000);
  });

  it('answers null for a conversation with no draft', async () => {
    const drafts = createDraftStore(createMemoryStore());

    await expect(drafts.read('dm', 'nothing')).resolves.toBeNull();
  });

  it('keeps a channel draft apart from a conversation draft', async () => {
    const drafts = createDraftStore(createMemoryStore());

    await drafts.write(draft('channel', 'same', 'in a channel'));
    await drafts.write(draft('dm', 'same', 'in a conversation'));

    await expect(drafts.read('channel', 'same')).resolves.toMatchObject({
      body: 'in a channel',
    });
    await expect(drafts.read('dm', 'same')).resolves.toMatchObject({
      body: 'in a conversation',
    });
  });

  it('replaces a draft rather than adding a second one', async () => {
    const drafts = createDraftStore(createMemoryStore());

    await drafts.write(draft('channel', 'c1', 'first'));
    await drafts.write(draft('channel', 'c1', 'second'));

    const all = await drafts.list();
    expect(all).toHaveLength(1);
    await expect(drafts.read('channel', 'c1')).resolves.toMatchObject({
      body: 'second',
    });
  });

  it('forgets a draft once the message has gone', async () => {
    const drafts = createDraftStore(createMemoryStore());

    await drafts.write(draft('channel', 'c1', 'sent'));
    await drafts.remove('channel', 'c1');

    await expect(drafts.read('channel', 'c1')).resolves.toBeNull();
    await expect(drafts.list()).resolves.toEqual([]);
  });

  it('does not mind being asked to remove a draft that is not there', async () => {
    const drafts = createDraftStore(createMemoryStore());

    await expect(drafts.remove('channel', 'never-existed')).resolves.toBeUndefined();
  });

  it('keeps the drafts of one instance away from another', async () => {
    const store = createMemoryStore();
    const one = createDraftStore(store, {namespace: 'https://one.example'});
    const two = createDraftStore(store, {namespace: 'https://two.example'});

    await one.write(draft('channel', 'c1', 'on the first'));
    await two.write(draft('channel', 'c1', 'on the second'));

    await expect(one.read('channel', 'c1')).resolves.toMatchObject({
      body: 'on the first',
    });
    await expect(two.read('channel', 'c1')).resolves.toMatchObject({
      body: 'on the second',
    });
  });

  it('survives an index it cannot read', async () => {
    const store = createMemoryStore();
    await store.set('trycord.drafts.v1', 'not json at all');
    const drafts = createDraftStore(store);

    await expect(drafts.list()).resolves.toEqual([]);
    await expect(drafts.read('channel', 'c1')).resolves.toBeNull();
  });

  it('files a draft under a key that names its scope', () => {
    expect(draftKey('channel', 'c1')).toBe('trycord.draft.channel.c1');
    expect(draftKey('dm', 'c1', 'https://one.example')).toBe(
      'trycord.draft.https://one.example.dm.c1',
    );
  });
});
