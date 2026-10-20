// The layout.
//
// Three widths the reader can drag, three regions they can choose to see, and
// one density that changes how the workspace is put together. All three are
// remembered, and they are remembered for the account rather than for the
// browser: two people who share a machine each get their own arrangement.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { State } = await import('../packages/store.js');
const {
  readPrefs, patchPrefs, rememberContextWidth, rememberInspectorWidth, rememberStageWidth,
  rememberRegions, applyRegions, applyLayoutWidths, applyDensity, regionEnabled,
  CONTEXT_MIN, CONTEXT_MAX, INSPECTOR_MIN, INSPECTOR_MAX, STAGE_MIN, STAGE_MAX, REGIONS,
} = await import('../js/prefs.js');

function account(id) {
  State.user = { id, username: 'reader' };
}

function keys() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
  return out;
}

test('the widths the reader drags are remembered', () => {
  account('u1');
  rememberContextWidth(300);
  rememberInspectorWidth(400);
  rememberStageWidth(900);

  const prefs = readPrefs();
  assert.equal(prefs.contextWidth, 300);
  assert.equal(prefs.inspectorWidth, 400);
  assert.equal(prefs.stageWidth, 900);
});

test('a width outside its range is clamped rather than refused', () => {
  account('u1');
  rememberContextWidth(10);
  assert.equal(readPrefs().contextWidth, CONTEXT_MIN);
  rememberContextWidth(9000);
  assert.equal(readPrefs().contextWidth, CONTEXT_MAX);
  rememberInspectorWidth(1);
  assert.equal(readPrefs().inspectorWidth, INSPECTOR_MIN);
  rememberStageWidth(99999);
  assert.equal(readPrefs().stageWidth, STAGE_MAX);
});

test('the widths reach the workspace as the properties the stylesheet reads', () => {
  account('u1');
  rememberContextWidth(310);
  rememberInspectorWidth(410);
  rememberStageWidth(910);
  const root = document.createElement('div');
  applyLayoutWidths(root);
  assert.equal(root.style.getPropertyValue('--context-w'), '310px');
  assert.equal(root.style.getPropertyValue('--inspector-w'), '410px');
  assert.equal(root.style.getPropertyValue('--stage-w'), '910px');
});

test('the regions the reader chooses are remembered and restored', () => {
  account('u1');
  rememberRegions({ rail: false, column: true, inspector: false });

  const prefs = readPrefs();
  assert.equal(prefs.regions.rail, false);
  assert.equal(prefs.regions.column, true);
  assert.equal(prefs.regions.inspector, false);
  assert.equal(regionEnabled('rail'), false);
  assert.equal(regionEnabled('column'), true);

  const root = document.createElement('div');
  applyRegions(root);
  assert.equal(root.getAttribute('data-regions'), 'column');
});

test('a region that was never chosen is on', () => {
  account('u1');
  patchPrefs({ regions: {} });
  assert.deepEqual(readPrefs().regions, { rail: true, column: true, inspector: true });
  for (const region of REGIONS) assert.equal(regionEnabled(region), true);
});

test('the arrangement belongs to the account, not to the browser', () => {
  account('u1');
  rememberStageWidth(800);
  const first = keys().filter((key) => key.indexOf('trycord.workspace') === 0);
  assert.equal(first.length, 1, 'the arrangement is not stored under one key');

  account('u2');
  assert.notEqual(readPrefs().stageWidth, 800, 'the other account inherited the arrangement');
  rememberStageWidth(1400);
  assert.equal(readPrefs().stageWidth, 1400);

  account('u1');
  assert.equal(readPrefs().stageWidth, 800, 'the first account lost its arrangement');
  const second = keys().filter((key) => key.indexOf('trycord.workspace') === 0);
  assert.equal(second.length, 2, 'the two accounts share one key');
});

test('the density choice is a composition, not only a word on the document', () => {
  account('u1');
  patchPrefs({ density: 'compact' });
  assert.equal(applyDensity(), 'compact');
  assert.equal(document.documentElement.getAttribute('data-density'), 'compact');

  patchPrefs({ density: 'cozy' });
  applyDensity();
  assert.equal(document.documentElement.getAttribute('data-density'), null,
    'the ordinary density should leave the document as it found it');
});
