// The incident timeline on the status page.
//
// The rule the page has to keep: it shows **exactly what an operator
// wrote** and nothing invented. No uptime percentage nobody computed, no
// "everything is operational" banner, no history that was not recorded.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..');

test('the incident timeline on the status page', async (t) => {
  await t.test('the status page carries the timeline and the script that fills it', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'status.html'), 'utf8');
    assert.ok(/data-incidents/.test(html), 'the page has the timeline region');
    assert.ok(/data-incident-list/.test(html), 'the page has the list the entries go in');
    assert.ok(/data-incidents-empty/.test(html), 'the page says when there is nothing to show');
    // The script has to come after the resolver, or it finds no API to ask.
    const apiAt = html.indexOf('/js/public-api.js');
    const incidentsAt = html.indexOf('/js/incidents.js');
    assert.ok(apiAt !== -1, 'the page loads the API resolver');
    assert.ok(incidentsAt !== -1, 'the page loads the timeline script');
    assert.ok(incidentsAt > apiAt, 'the timeline script loads after the resolver it needs');
  });

  await t.test('the timeline renders what the instance recorded', () => {
    const source = fs.readFileSync(path.join(PUBLIC, 'js', 'incidents.js'), 'utf8');
    // The fields the API answers with, so a rename on the server does not
    // leave the page showing an empty status.
    assert.ok(/startedAt/.test(source), 'the page reads the start time');
    assert.ok(/updatedAt/.test(source), 'the page reads the update time');
    assert.ok(/summary/.test(source), 'the page shows the summary');
    assert.ok(/status/.test(source), 'the page shows the state');
  });

  await t.test('the page invents nothing', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'status.html'), 'utf8');
    const source = fs.readFileSync(path.join(PUBLIC, 'js', 'incidents.js'), 'utf8');
    // The comments are not claims. A source file that says "no uptime
    // percentages" in a comment is not claiming an uptime percentage.
    const said = (text) => text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // A *claim* of uptime, a percentage, or an "all systems" banner would be
    // something this instance cannot know. The page may say that it does not
    // have one - that is the opposite of a claim.
    const claims = [
      /\b\d+(\.\d+)?\s*%\s*uptime/i,
      /\buptime\b(?![^.]*\b(no|not|never)\b)[^.]*[.:]?\s*$/im,
      /all systems (operational|normal)/i,
      /\b\d+(\.\d+)?\s*%\s*(availability|uptime)/i,
    ];
    for (const claim of claims) {
      assert.ok(!claim.test(said(html)), 'the page does not claim: ' + claim);
      assert.ok(!claim.test(said(source)), 'the timeline does not claim: ' + claim);
    }
    // The live checks already say what they are, and the timeline says what
    // it is: what an operator wrote down.
    assert.ok(/This is one instance at one moment/.test(html),
      'the page still says what its checks are');
    assert.ok(/nobody wrote that down/.test(html),
      'the page says the absence of a record is not a claim of health');
  });

  await t.test('the timeline styles come from the token layer', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'site.css'), 'utf8');
    for (const rule of ['.status-incidents', '.incident-list', '.incident', '.incident-head', '.incident-title']) {
      assert.ok(css.includes(rule), 'the stylesheet has ' + rule);
    }
    // No raw colour values: the site's own layer is the source.
    const block = css.slice(css.indexOf('.status-incidents'), css.indexOf('.status-incidents') + 1400);
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), 'the timeline styles use the tokens, not raw colours');
  });
});
