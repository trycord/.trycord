/**
 * The deep-link parser.
 *
 * A link says where to go. The parser accepts a fixed set of shapes and
 * refuses everything else, so a link cannot be talked into opening something
 * it was not written for.
 */

import {buildDeepLink, parseDeepLink, parseLink} from '../parser';

describe('the deep-link parser', () => {
  it('reads a community by its slug', () => {
    expect(parseDeepLink('trycord://community/lounge')).toEqual({
      kind: 'community',
      communityRef: 'lounge',
    });
  });

  it('reads a community with three slashes in front of it', () => {
    expect(parseDeepLink('trycord:///community/lounge')).toEqual({
      kind: 'community',
      communityRef: 'lounge',
    });
  });

  it('reads a channel inside a community', () => {
    expect(parseDeepLink('trycord://community/lounge/channel/general')).toEqual({
      kind: 'channel',
      communityRef: 'lounge',
      channelId: 'general',
      messageId: undefined,
    });
  });

  it('reads a channel given on its own with the community in the query', () => {
    expect(
      parseDeepLink('trycord://channel/general?community=lounge'),
    ).toEqual({
      kind: 'channel',
      communityRef: 'lounge',
      channelId: 'general',
      messageId: undefined,
    });
  });

  it('reads a message inside a channel', () => {
    expect(
      parseDeepLink('trycord://community/lounge/channel/general?message=m9'),
    ).toEqual({
      kind: 'channel',
      communityRef: 'lounge',
      channelId: 'general',
      messageId: 'm9',
    });
  });

  it('reads a direct conversation', () => {
    expect(parseDeepLink('trycord://dm/conv-1')).toEqual({
      kind: 'dm',
      conversationId: 'conv-1',
      messageId: undefined,
    });
  });

  it('reads a password reset link', () => {
    expect(parseDeepLink('trycord://reset/token-1')).toEqual({
      kind: 'resetPassword',
      token: 'token-1',
    });
    expect(parseDeepLink('https://trycord.example/reset-password/token-1')).toEqual({
      kind: 'resetPassword',
      token: 'token-1',
    });
  });

  it('refuses a reset link with no token', () => {
    expect(parseDeepLink('trycord://reset')).toBeNull();
  });

  it('reads a message inside a direct conversation', () => {
    expect(parseDeepLink('trycord://message/m9?conversation=conv-1')).toEqual({
      kind: 'dm',
      conversationId: 'conv-1',
      messageId: 'm9',
    });
  });

  it('reads a person', () => {
    expect(parseDeepLink('trycord://profile/u-1')).toEqual({
      kind: 'profile',
      userId: 'u-1',
    });
  });

  it('reads the places that are not a conversation', () => {
    expect(parseDeepLink('trycord://settings')).toEqual({kind: 'settings'});
    expect(parseDeepLink('trycord://instances')).toEqual({kind: 'instances'});
    expect(parseDeepLink('trycord://conversations')).toEqual({
      kind: 'conversations',
    });
  });

  it('reads the addresses the web client serves', () => {
    expect(parseDeepLink('https://trycord.example/server/lounge')).toEqual({
      kind: 'community',
      communityRef: 'lounge',
    });
    expect(
      parseDeepLink('https://trycord.example/server/lounge/channel/general'),
    ).toEqual({
      kind: 'channel',
      communityRef: 'lounge',
      channelId: 'general',
      messageId: undefined,
    });
    expect(parseDeepLink('https://trycord.example/dms/conv-1')).toEqual({
      kind: 'dm',
      conversationId: 'conv-1',
      messageId: undefined,
    });
    expect(parseDeepLink('https://trycord.example/users/u-1')).toEqual({
      kind: 'profile',
      userId: 'u-1',
    });
  });

  it('refuses a link that is not one of ours', () => {
    expect(parseDeepLink('mailto:someone@example.com')).toBeNull();
    expect(parseDeepLink('ftp://files.example.com/thing')).toBeNull();
    expect(parseDeepLink('not a link at all')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });

  it('refuses a shape it does not know', () => {
    expect(parseDeepLink('trycord://nowhere/at/all')).toBeNull();
    expect(parseDeepLink('trycord://community')).toBeNull();
    expect(parseDeepLink('trycord://dm')).toBeNull();
  });

  it('does not read a channel without the community it belongs to', () => {
    expect(parseDeepLink('trycord://channel/general')).toBeNull();
  });

  it('decodes a name that was written with escapes', () => {
    expect(parseDeepLink('trycord://community/the%20lounge')).toEqual({
      kind: 'community',
      communityRef: 'the lounge',
    });
  });

  it('splits a link into its parts', () => {
    const link = parseLink('trycord://community/lounge?tab=channels');
    expect(link?.scheme).toBe('trycord');
    expect(link?.segments).toEqual(['community', 'lounge']);
    expect(link?.query.tab).toBe('channels');
  });

  it('writes a place to go as a link that reads back the same', () => {
    const target = {
      kind: 'channel' as const,
      communityRef: 'lounge',
      channelId: 'general',
    };
    const link = buildDeepLink(target);

    expect(link).toBe('trycord://community/lounge/channel/general');
    expect(parseDeepLink(link)).toEqual({
      kind: 'channel',
      communityRef: 'lounge',
      channelId: 'general',
      messageId: undefined,
    });
  });

  it('writes a message into the link that carries it', () => {
    const link = buildDeepLink({
      kind: 'dm',
      conversationId: 'conv-1',
      messageId: 'm9',
    });

    expect(link).toBe('trycord://dm/conv-1?message=m9');
    expect(parseDeepLink(link)).toMatchObject({messageId: 'm9'});
  });
});
