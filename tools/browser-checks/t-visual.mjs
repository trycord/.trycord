// The visual faults that a screenshot found and a selector did not.
//
// Both of these shipped once and looked correct in code. An icon that has lost
// its size rule renders as a full-width block; a flex row stretches its text to
// fill whatever it is given and pushes its metadata to the far edge. Neither is
// a syntax error, so `check:client` passes either way, and neither throws.
//
// That is the argument for measuring the rendered geometry rather than trusting
// that a stylesheet is present.

import { launch, waitForServer, signedIn } from './cdp.mjs';

const B = process.env.TC_ORIGIN || 'http://127.0.0.1:9975';
let pass = 0, fail = 0; const bad = [];
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; bad.push(n); console.log('  FAIL  ' + n + (x !== undefined ? '  <<< ' + JSON.stringify(x).slice(0, 260) : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await waitForServer(B + '/api/health');
const page = await launch({ width: 1440, height: 900 });
try {
  const { serverId } = await signedIn(page, B, { seedCommunity: true });
  ok('signed in with a community', !!serverId, serverId);

  // Anything larger than this is a glyph that has lost its size rule. The
  // largest intentional icon in the application is a room avatar at 48px.
  const MAX_ICON_PX = 64;

  console.log('\n=== no icon has escaped its size rule ===');
  // Every surface that renders one, walked directly rather than trusting a list.
  const routes = [
    '/home',
    '/c/' + serverId,
    '/c/' + serverId + '/settings/overview',
    '/c/' + serverId + '/settings/members',
    '/c/' + serverId + '/settings/roles',
    '/c/' + serverId + '/settings/analytics',
    '/c/' + serverId + '/settings/integrations',
    '/dms',
    '/friends',
    '/notifications',
    '/discover',
    '/settings',
    '/settings/appearance',
    '/settings/privacy',
    '/users/me',
  ];
  let worst = { w: 0 };
  for (const route of routes) {
    await page.goto(B + route, { waitMs: 2200 });
    await wait(700);
    const big = await page.eval(`
      const MAX = ${MAX_ICON_PX};
      return [...document.querySelectorAll('svg')]
        .map(s => {
          const r = s.getBoundingClientRect();
          return { cls: (s.getAttribute('class') || '(none)').slice(0, 44),
                   w: Math.round(r.width), h: Math.round(r.height) };
        })
        // A hidden element has no meaningful size and is not a fault.
        .filter(x => x.w > 0 && (x.w > MAX || x.h > MAX))
        .sort((a, b) => b.w - a.w)
        .slice(0, 3);
    `);
    if (big.length) {
      ok(route + ': no oversized icon', false, big);
      if (big[0].w > worst.w) worst = { route, ...big[0] };
    }
  }
  ok('no icon on any surface exceeds ' + MAX_ICON_PX + 'px', worst.w === 0, worst);

  console.log('\n=== the settings caret specifically ===');
  // It only renders above 900px, so the viewport is set rather than assumed.
  await page.setViewport(1440, 900);
  await page.goto(B + '/c/' + serverId + '/settings/roles', { waitMs: 2400 });
  await wait(1000);
  const caret = await page.eval(`
    const c = document.querySelector('.settings-nav__toggle-caret');
    if (!c) return { present: false };
    const r = c.getBoundingClientRect();
    return { present: true, w: Math.round(r.width), h: Math.round(r.height),
             hasBase: c.classList.contains('ui-icon') };
  `);
  ok('the caret is rendered', caret.present, caret);
  if (caret.present) {
    ok('the caret keeps the base class that gives it a size', caret.hasBase, caret);
    ok('the caret is 14px wide, not hundreds', caret.w > 0 && caret.w <= 20, caret);
  }

  console.log('\n=== the activity feed has a measure ===');
  for (const width of [1440, 2560]) {
    await page.setViewport(width, 900);
    await page.goto(B + '/home', { waitMs: 2400 });
    await wait(900);
    const feed = await page.eval(`
      const rows = [...document.querySelectorAll('.home-stream > .home-event')];
      if (!rows.length) return { none: true };
      const cs = getComputedStyle(rows[0]);
      const region = document.querySelector('.home-stream').getBoundingClientRect();
      return {
        count: rows.length,
        rowW: Math.round(rows[0].getBoundingClientRect().width),
        regionW: Math.round(region.width),
        maxWidth: cs.maxWidth,
        marginLeft: cs.marginLeft,
        // The point of the fix: the gap between the text and its timestamp.
        gaps: rows.slice(0, 6).map(r => {
          const meta = r.querySelector('.row-meta');
          const main = r.querySelector('.row-main');
          if (!meta || !main) return null;
          return Math.round(meta.getBoundingClientRect().left
            - main.getBoundingClientRect().right);
        }).filter(n => typeof n === 'number'),
      };
    `);
    ok(width + ': the feed rendered rows', !feed.none, feed);
    if (!feed.none) {
      ok(width + ': rows are narrower than the region', feed.rowW < feed.regionW, feed);
      // A timestamp pushed to the far edge shows up here as a large gap.
      const worstGap = Math.max(0, ...(feed.gaps || [0]));
      ok(width + ': timestamps sit with their text (gap under 200px)',
        worstGap < 200, { worstGap, gaps: feed.gaps });
    }
  }

  console.log('\n=== nothing overflows horizontally ===');
  for (const [w, h] of [[390, 844], [768, 1024], [1280, 720], [1920, 1080], [2560, 1440]]) {
    await page.setViewport(w, h);
    await page.goto(B + '/home', { waitMs: 2200 });
    await wait(700);
    const over = await page.eval(`
      const vw = window.innerWidth;
      const doc = document.documentElement;
      return { scrollW: doc.scrollWidth, vw,
               offenders: [...document.querySelectorAll('*')]
                 .filter(e => e.getBoundingClientRect().right > vw + 1)
                 .slice(0, 3)
                 .map(e => e.tagName.toLowerCase() + '.' + (e.className || '').toString().split(' ')[0]) };
    `);
    ok(w + 'x' + h + ': no horizontal overflow', over.scrollW <= over.vw + 1, over);
  }
} finally {
  await page.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (bad.length) console.log('failed: ' + bad.join(' | '));
process.exit(fail ? 1 : 0);