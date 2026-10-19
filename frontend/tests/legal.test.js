// The legal versions a registration is recorded against.
//
// The server accepts a registration only when the versions it carries match
// the documents in force. A client that writes a version of its own is
// refused the day the documents change, so no client may hold one, and every
// client must send the versions the instance published.
//
// The check has three parts: the helper that resolves the versions is
// exercised directly, no file in the client may name a version, and the
// registration call site must go through the helper.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  legalVersions, withLegalVersions, isStaleLegalError, legalDocuments,
} from '../packages/legal.js';
import { MODULES, walk, relative, read } from './helpers/source.js';

const clientFiles = [
  ...walk(MODULES.packages),
  ...walk(MODULES.desktop),
  ...walk(MODULES.mobile),
];

test('the versions in force are the ones the instance published', () => {
  const versions = legalVersions({ termsVersion: '1.0', privacyVersion: '1.0', updated: '2026-09-20' });
  assert.deepEqual(versions, { termsVersion: '1.0', privacyVersion: '1.0' });
});

test('half a version is no version', () => {
  assert.equal(legalVersions({ termsVersion: '1.0' }), null);
  assert.equal(legalVersions({ privacyVersion: '1.0' }), null);
  assert.equal(legalVersions(null), null);
  assert.equal(legalVersions({}), null);
});

test('a registration carries the versions and keeps the fields it was given', () => {
  const body = withLegalVersions(
    { username: 'ada', password: 'a-long-enough-password' },
    { termsVersion: '2.1', privacyVersion: '3.0' },
  );
  assert.equal(body.username, 'ada');
  assert.equal(body.password, 'a-long-enough-password');
  assert.equal(body.termsVersion, '2.1');
  assert.equal(body.privacyVersion, '3.0');
});

test('a registration without the versions in force carries none', () => {
  const body = withLegalVersions({ username: 'ada' }, null);
  assert.equal(body.username, 'ada');
  assert.equal(body.termsVersion, undefined);
  assert.equal(body.privacyVersion, undefined);
});

test('the versions are sent as the strings the server compares', () => {
  const body = withLegalVersions({}, { termsVersion: 2, privacyVersion: 3 });
  assert.equal(body.termsVersion, '2');
  assert.equal(body.privacyVersion, '3');
});

test('a refusal over the documents is recognised', () => {
  const stale = {
    code: 'VALIDATION_ERROR',
    message: 'please accept the current Terms of Service and Privacy Policy',
  };
  assert.equal(isStaleLegalError(stale), true);
  assert.equal(isStaleLegalError({ code: 'VALIDATION_ERROR', message: 'username taken' }), false);
  assert.equal(isStaleLegalError({ code: 'CONFLICT', message: 'Terms of Service changed' }), false);
  assert.equal(isStaleLegalError(null), false);
});

test('the documents the acceptance control links to are named', () => {
  const documents = legalDocuments();
  assert.deepEqual(documents.map((doc) => doc.key), ['terms', 'privacy']);
  for (const doc of documents) {
    assert.ok(doc.route.startsWith('/'), doc.key + ' has no address');
    assert.ok(doc.label.length > 0, doc.key + ' has no name');
  }
});

test('no client file names a legal version of its own', () => {
  const offenders = [];
  for (const file of clientFiles) {
    const source = read(file);
    const patterns = [/termsVersion\s*:\s*['"]/, /privacyVersion\s*:\s*['"]/];
    for (const pattern of patterns) {
      if (pattern.test(source)) offenders.push(relative(file) + ' holds a version string');
    }
  }
  assert.deepEqual(offenders, [], 'a client file that names a legal version:\n' + offenders.join('\n'));
});

test('the desktop registration sends the versions the instance published', () => {
  const source = read(path.join(MODULES.desktop, 'features', 'auth.js'));
  assert.ok(
    /withLegalVersions\(\{/.test(source),
    'the desktop registration does not go through withLegalVersions',
  );
  assert.ok(
    /Api\.register\(withLegalVersions/.test(source),
    'the desktop registration does not send the versions',
  );
});

test('the mobile registration sends the versions the instance published', () => {
  const source = read(path.join(MODULES.mobile, 'views', 'auth.js'));
  assert.ok(
    /Api\.register\(withLegalVersions/.test(source),
    'the mobile registration does not send the versions',
  );
});

test('both registrations refuse to be sent without acceptance', () => {
  for (const file of [
    path.join(MODULES.desktop, 'features', 'auth.js'),
    path.join(MODULES.mobile, 'views', 'auth.js'),
  ]) {
    const source = read(file);
    assert.ok(
      /accepted\.checked/.test(source),
      relative(file) + ' does not check that the documents were accepted',
    );
  }
});
