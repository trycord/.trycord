/**
 * The end-to-end encryption adapter.
 *
 * The adapter is deliberately unimplemented until the cryptography is
 * written. What is tested here is that it says so, rather than pretending to
 * encrypt: a client that claims to protect a message and quietly sends it in
 * the clear is worse than one that admits it cannot.
 */

import {createUnimplementedE2eeAdapter, openEnvelope} from '../adapter';
import {E2EE_PROTOCOL_VERSION} from '../envelope';

const scope = {kind: 'channel' as const, id: 'conversation-1', communityId: 's1'};

const envelope = {
  v: E2EE_PROTOCOL_VERSION,
  sid: 'session-1',
  cid: 'conversation-1',
  from: 'device-a',
  to: 'device-b',
  ctr: 7,
  dh: 'A'.repeat(43),
  iv: 'B'.repeat(16),
  ct: 'ZA',
  tag: 'C'.repeat(22),
  hiv: 'B'.repeat(16),
  hct: 'ZA',
  htag: 'C'.repeat(22),
};

describe('the unimplemented adapter', () => {
  it('says it cannot seal a message', async () => {
    const adapter = createUnimplementedE2eeAdapter();

    expect(adapter.supported).toBe(false);
    await expect(adapter.encrypt('hello', scope)).rejects.toThrow(
      /not implemented/,
    );
  });

  it('says it cannot open a message', async () => {
    const adapter = createUnimplementedE2eeAdapter();

    await expect(adapter.decrypt(envelope)).rejects.toThrow(/not implemented/);
  });

  it('reports that nothing is encrypted', () => {
    const adapter = createUnimplementedE2eeAdapter();

    expect(adapter.isEncrypted(scope)).toBe(false);
  });

  it('leaves an ordinary message alone', async () => {
    const adapter = createUnimplementedE2eeAdapter();

    await expect(openEnvelope(adapter, 'just text', scope)).resolves.toBeNull();
    await expect(openEnvelope(adapter, null, scope)).resolves.toBeNull();
  });
});
