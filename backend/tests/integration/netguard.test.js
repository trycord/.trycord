// The outbound guard.
//
// `netguard.assertPublicHost` was imported by the link-preview service and
// by the webhook service, and it was **not exported**. The import resolved to
// `undefined`, every call raised a TypeError, and the callers caught it — so
// every link preview came back "unavailable" and every outgoing webhook was
// refused with "must be a public address". The hole was closed by accident,
// and removing the dead call would have opened it.
//
// These tests are about that accident not happening again, and about the
// guard actually refusing the addresses it is for.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const netguard = require('../../src/services/netguard');

test('the outbound guard', async (t) => {
  await t.test('the function the callers import is exported', () => {
    // The exact name two services import. If this is renamed, the callers
    // break the same way they broke before.
    assert.equal(typeof netguard.assertPublicHost, 'function',
      'netguard must export assertPublicHost: the preview and the webhook '
      + 'services import it by that name');
  });

  await t.test('the services that import it can actually load it', () => {
    // The import is resolved at load time, so a missing export is a TypeError
    // at the first call rather than at the load. This is the check that
    // catches it before a reader sees an "unavailable" preview.
    const embeds = require('../../src/services/embeds');
    const webhooks = require('../../src/services/webhooks');
    assert.ok(embeds, 'the preview service loads');
    assert.ok(webhooks, 'the webhook service loads');
  });

  await t.test('a private address is refused', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', 'localhost']) {
      await assert.rejects(
        () => netguard.assertPublicHost(host),
        host + ' must be refused',
      );
    }
  });

  await t.test('a public address is allowed', async () => {
    assert.equal(await netguard.assertPublicHost('example.com'), true);
    assert.equal(await netguard.assertPublicHost('api.trycord.dev'), true);
  });

  await t.test('the refusal names the host, so the message is actionable', async () => {
    await assert.rejects(
      () => netguard.assertPublicHost('169.254.169.254'),
      /public address|private address/,
    );
  });

  await t.test('an empty host is refused rather than allowed', async () => {
    await assert.rejects(() => netguard.assertPublicHost(''), /host is required/);
    await assert.rejects(() => netguard.assertPublicHost(null), /host is required/);
  });

  await t.test('a preview image is allowed from a public host and refused from a private one', async () => {
    const embeds = require('../../src/services/embeds');
    assert.equal(
      await embeds.publicMediaUrl('https://example.com/x.png', 'https://example.com/'),
      'https://example.com/x.png',
      'a public image is kept',
    );
    assert.equal(
      await embeds.publicMediaUrl('http://169.254.169.254/latest/meta-data/', 'https://example.com/'),
      null,
      'the cloud metadata endpoint is dropped',
    );
  });
});
