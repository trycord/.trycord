/**
 * The push payload.
 *
 * The rule is that a push carries no message content: the payload says where
 * to go and nothing else. These tests hold that rule to the letter.
 */

import {
  assertPrivacySafe,
  buildPushPayload,
  containsMessageContent,
  FORBIDDEN_PAYLOAD_KEYS,
  PUSH_PAYLOAD_VERSION,
  pushNotificationTitle,
} from '../payload';

describe('the push payload', () => {
  it('names the version of the format it writes', () => {
    const payload = buildPushPayload({
      type: 'message',
      scope: 'channel',
      communityId: 's1',
      channelId: 'c1',
      messageId: 'm1',
      referenceId: 'ref-1',
    });

    expect(payload.v).toBe(PUSH_PAYLOAD_VERSION);
  });

  it('carries only the identifiers and the kind', () => {
    const payload = buildPushPayload({
      type: 'mention',
      scope: 'channel',
      communityId: 's1',
      channelId: 'c1',
      messageId: 'm1',
      referenceId: 'ref-1',
    });

    expect(Object.keys(payload).sort()).toEqual(['ref', 'target', 'type', 'v']);
    expect(Object.keys(payload.target).sort()).toEqual([
      'channelId',
      'communityId',
      'conversationId',
      'messageId',
      'scope',
    ]);
  });

  it('does not carry the message content', () => {
    const payload = buildPushPayload({
      type: 'message',
      scope: 'channel',
      communityId: 's1',
      channelId: 'c1',
      messageId: 'm1',
      referenceId: 'ref-1',
      content: 'the meeting is at four',
    });

    expect(JSON.stringify(payload)).not.toContain('the meeting is at four');
    expect(containsMessageContent(payload, 'the meeting is at four')).toBe(false);
    expect(() => assertPrivacySafe(payload, 'the meeting is at four')).not.toThrow();
  });

  it('refuses a payload that carries a forbidden key', () => {
    const payload = {
      v: PUSH_PAYLOAD_VERSION,
      type: 'message',
      target: {
        scope: 'channel' as const,
        communityId: 's1',
        channelId: 'c1',
        conversationId: null,
        messageId: null,
      },
      ref: 'ref-1',
      content: 'the meeting is at four',
    };

    expect(() =>
      assertPrivacySafe(payload as never, 'the meeting is at four'),
    ).toThrow(/must not carry "content"/);
  });

  it('refuses a payload that carries the text it was built from', () => {
    const payload = buildPushPayload({
      type: 'message',
      scope: 'dm',
      conversationId: 'conv-1',
      messageId: 'm1',
      referenceId: 'ref-1',
    });

    const leaking = {
      ...payload,
      ref: 'the meeting is at four',
    };

    expect(containsMessageContent(leaking, 'the meeting is at four')).toBe(true);
    expect(() => assertPrivacySafe(leaking, 'the meeting is at four')).toThrow(
      /must not carry the message content/,
    );
  });

  it('writes a title that says nothing about the message', () => {
    const payload = buildPushPayload({
      type: 'message',
      scope: 'dm',
      conversationId: 'conv-1',
      messageId: 'm1',
      referenceId: 'ref-1',
    });

    const title = pushNotificationTitle(payload);

    expect(title).toBe('New message');
    expect(title).not.toContain('conv-1');
    expect(title).not.toContain('m1');
  });

  it('names the kind of thing that happened in the title', () => {
    const mention = buildPushPayload({
      type: 'mention',
      scope: 'channel',
      channelId: 'c1',
      referenceId: 'ref-1',
    });
    const reply = buildPushPayload({
      type: 'reply',
      scope: 'channel',
      channelId: 'c1',
      referenceId: 'ref-1',
    });

    expect(pushNotificationTitle(mention)).toBe('You were mentioned');
    expect(pushNotificationTitle(reply)).toBe('New reply');
  });

  it('lists the keys a payload may never carry', () => {
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain('content');
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain('title');
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain('author');
  });

  it('does not report a leak for an empty sample', () => {
    const payload = buildPushPayload({
      type: 'message',
      scope: 'dm',
      conversationId: 'conv-1',
      referenceId: 'ref-1',
    });

    expect(containsMessageContent(payload, '')).toBe(false);
    expect(containsMessageContent(payload, null)).toBe(false);
  });
});
