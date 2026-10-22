// Two modules, two of everything.
//
// The desktop and the phone are not one interface at two widths: they are two
// interfaces that share the platform. Everything the desktop offers, the phone
// offers in its own way - a menu is a long press, a resizable column is a
// sheet, a member list is a screen.
//
// The check is that each module carries its own implementation and its own
// stored choices, and that neither of them reaches into the other for them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installDomStub } from './helpers/dom-stub.js';
import { CLIENT, read, relative } from './helpers/source.js';

installDomStub();

const desktopPrefs = await import('../js/prefs.js');
const mobilePrefs = await import('../mobile/js/prefs.js');
const { State } = await import('../packages/store.js');

const DESKTOP_PREF_FILE = path.join(CLIENT, 'js', 'prefs.js');
const MOBILE_PREF_FILE = path.join(CLIENT, 'mobile', 'js', 'prefs.js');

test('the two modules keep their own preferences', () => {
  assert.notEqual(DESKTOP_PREF_FILE, MOBILE_PREF_FILE);
  assert.ok(fs.existsSync(DESKTOP_PREF_FILE));
  assert.ok(fs.existsSync(MOBILE_PREF_FILE));

  const desktop = read(DESKTOP_PREF_FILE);
  const mobile = read(MOBILE_PREF_FILE);
  assert.match(desktop, /trycord\.workspace/);
  assert.match(mobile, /trycord\.mobile/);
  assert.doesNotMatch(mobile, /trycord\.workspace/);
  assert.doesNotMatch(desktop, /trycord\.mobile/);
});

test('neither module reaches into the other for its preferences', () => {
  const desktop = read(DESKTOP_PREF_FILE);
  const mobile = read(MOBILE_PREF_FILE);
  assert.doesNotMatch(desktop, /mobile\//, 'the desktop module names the mobile one');
  assert.doesNotMatch(mobile, /from '\.\.\/\.\.\/js\//, 'the mobile module names the desktop one');
});

test('the two modules store their choices apart', () => {
  State.user = { id: 'u1', username: 'reader' };

  desktopPrefs.patchPrefs({ density: 'compact', stageWidth: 800 });
  mobilePrefs.patchPrefs({ density: 'comfortable' });

  assert.equal(desktopPrefs.readPrefs().density, 'compact');
  assert.equal(mobilePrefs.readPrefs().density, 'comfortable');

  const stored = [];
  for (let i = 0; i < localStorage.length; i++) stored.push(localStorage.key(i));
  assert.ok(stored.some((key) => key.indexOf('trycord.workspace') === 0), 'the desktop kept nothing');
  assert.ok(stored.some((key) => key.indexOf('trycord.mobile') === 0), 'the phone kept nothing');
});

test('the phone has its own composition choices', () => {
  // The phone's choices are about the phone: how dense it is and what the
  // bottom bar carries. The desktop's are about columns and panels.
  assert.ok(mobilePrefs.TABS.length > 0, 'the phone has no bottom bar to arrange');
  assert.ok(mobilePrefs.DENSITIES.length > 0, 'the phone has no density to choose');
  assert.ok(desktopPrefs.REGIONS.length > 0, 'the desktop has no regions to arrange');
  assert.equal(mobilePrefs.rememberTabs(['dms', 'communities']).tabs.join(','), 'dms,communities');
});

test('each module draws its own preview card', () => {
  const desktop = read(path.join(CLIENT, 'js', 'ui', 'embeds.js'));
  const mobile = read(path.join(CLIENT, 'mobile', 'js', 'embeds.js'));
  assert.match(desktop, /embed-card/);
  assert.match(mobile, /m-embed/);
  assert.doesNotMatch(desktop, /mobile\//, 'the desktop module names the mobile one');
  assert.doesNotMatch(mobile, /\.\.\/\.\.\/js\//, 'the mobile module names the desktop one');
});

test('each module draws its own roster', () => {
  const desktop = read(path.join(CLIENT, 'js', 'ui', 'members.js'));
  const mobile = read(path.join(CLIENT, 'mobile', 'js', 'views', 'community.js'));
  assert.match(desktop, /presenceOf/);
  assert.match(mobile, /presenceOf/);
  assert.doesNotMatch(desktop, /mobile\//, 'the desktop roster names the mobile one');
  assert.doesNotMatch(mobile, /from '\.\.\/\.\.\/js\//, 'the mobile roster names the desktop one');
});
