// The demo has to be honest about what it is.
//
// A demonstration that reads a real community list is useful, and one that
// invents the rest is fine, as long as it says which is which. The failure
// this catches is a demo that reads as though it were a live instance: a
// reader who is shown fake messages should never be left thinking they are
// real, and a reader in the demo should always be able to find the way to a
// real instance.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_DIR, read } = require('./helpers');

const DEMO_PAGE = path.join(PUBLIC_DIR, 'demo.html');
const DEMO_SCRIPT = path.join(PUBLIC_DIR, 'js', 'demo.js');
const SAMPLE_SCRIPT = path.join(PUBLIC_DIR, 'js', 'sample-data.js');

test('the demo page says which half of it is simulated', () => {
  const html = read(DEMO_PAGE);
  assert.match(html, /simulated/i, 'the demo page does not label anything as simulated');
  assert.match(html, /live/i, 'the demo page does not say what is live');
  // The label has to be next to the thing it labels, not only in the lede.
  assert.match(html, /<strong>Simulated:<\/strong>/,
    'the demo page has no list of what is simulated');
});

test('the demo page names the instance it reads from', () => {
  const html = read(DEMO_PAGE);
  assert.match(html, /data-demo-source/,
    'the demo page does not say where its data comes from');
});

test('the demo script labels the messages it shows', () => {
  const source = read(DEMO_SCRIPT);
  assert.match(source, /Simulated/, 'the demo script does not label its output as simulated');
  assert.match(source, /'aria-label':\s*'Simulated messages'/,
    'the simulated message list is not labelled for a screen reader');
  assert.match(source, /data-demo-source/,
    'the demo script does not say where the live half came from');
});

test('the sample data says it is sample data', () => {
  const source = read(SAMPLE_SCRIPT);
  assert.match(source, /label:\s*'Sample data'/, 'the sample data is not labelled');
  assert.match(source, /not a live instance/i,
    'the sample data does not say that it is not a live instance');
  assert.match(source, /sample:\s*true/, 'the sample communities are not marked as samples');
});

test('the demo offers a genuine way to a real instance', () => {
  const html = read(DEMO_PAGE);
  // A link into the application, resolved by the instance rather than
  // hardcoded, and a route to running one.
  assert.match(html, /data-app-link/, 'the demo page has no way into the application');
  assert.match(html, /href="\/install"/, 'the demo page does not point at self-hosting');
  assert.match(html, /href="\/communities"/, 'the demo page does not point at the directory');
  // And it has to say that the application is the real thing.
  assert.match(html, /real instance/i, 'the demo page does not point at a real instance');
});

test('the demo does not offer to send anything to the instance', () => {
  const source = read(DEMO_SCRIPT);
  // Joining is a local state change. A call that would change the instance
  // would make the simulation a lie.
  assert.doesNotMatch(source, /Api\.join\(/,
    'the demo calls the join endpoint, which changes the instance');
  assert.doesNotMatch(source, /Api\.request\(/,
    'the demo makes a request of its own');
});
