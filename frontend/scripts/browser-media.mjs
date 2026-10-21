// The pictures on the screen.
//
// A picture in Trycord is not an <img src>: it is a file on the server that
// only the signed-in reader may fetch, so the client asks for the bytes with
// the session and draws them from an object URL. Every part of that can
// break quietly - a path that is not fetched, a fetch that is not made with
// the session, bytes that do not decode - and the page still looks like it
// works, because the initials are still there.
//
// So this check looks at the faces on the members page and asks three
// questions: was the picture asked for, did it arrive, and is it drawn.

import { harness, wait, writeHarnessDocument, freePort } from './browser-harness.mjs';

const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label, detail: detail || '' });
}

const run = await harness(await freePort(9460));
try {
  const document = writeHarnessDocument();
  await run.page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await run.nameRoute('/server/s1/members');
  await run.page.send('Page.navigate', { url: 'file://' + document });

  // The faces are drawn from the members list, so the list has to be there
  // before the faces can be.
  let ready = false;
  for (let i = 0; i < 80; i++) {
    ready = await run.page.evaluate(
      'return !!document.querySelector(".member-row");',
    ).catch(() => false);
    if (ready) break;
    await wait(100);
  }
  check(ready, 'the members page is drawn', ready ? '' : 'no member row was drawn');

  // The picture is fetched, and the bytes arrive.
  let state = null;
  for (let i = 0; i < 80; i++) {
    state = JSON.parse(await run.page.evaluate(`
      var rows = document.querySelectorAll('.member-row');
      var faces = [];
      for (var i = 0; i < rows.length; i++) {
        var face = rows[i].querySelector('.avatar');
        if (!face) continue;
        var img = face.querySelector('img');
        faces.push({
          title: face.getAttribute('title'),
          initials: (face.textContent || '').trim(),
          hasImage: !!img,
          width: img ? img.naturalWidth : -1,
          src: img ? String(img.src).slice(0, 5) : '',
        });
      }
      return JSON.stringify({
        faces: faces,
        calls: (window.__calls || []).filter(function (c) { return c.indexOf('attachments') !== -1; }),
        stub: window.__trycordStub === true,
      });
    `));
    if (state.faces.length && state.faces.every((face) => face.hasImage)) break;
    await wait(100);
  }

  check(state.stub === true,
    'the stub is answering the page', 'the stub did not announce itself');

  check(state.calls.length > 0,
    'the picture was asked for',
    state.calls.length ? state.calls.join(', ') : 'no request for a picture was made');

  check(state.faces.length > 0,
    'the roster has faces', state.faces.length + ' face(s)');

  const drawn = state.faces.filter((face) => face.hasImage);
  check(drawn.length === state.faces.length,
    'every face is drawn from the picture',
    drawn.length + ' of ' + state.faces.length + ' faces carry an image');

  const decoded = state.faces.filter((face) => face.hasImage && face.width > 0);
  check(decoded.length === state.faces.length,
    'every picture decodes',
    decoded.length + ' of ' + state.faces.length + ' pictures are an image the browser can read');

  check(state.faces.every((face) => face.hasImage || face.initials.length > 0),
    'a face without a picture keeps its initials',
    state.faces.map((face) => face.title + ': ' + (face.initials || '(a picture)')).join(', '));
} finally {
  await run.shutdown();
}

let failed = 0;
for (const entry of checks) {
  if (!entry.ok) failed++;
  console.log((entry.ok ? '  ok   ' : '  FAIL ') + entry.label + (entry.detail ? ' (' + entry.detail + ')' : ''));
}
if (failed) {
  console.log('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
