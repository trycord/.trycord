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
      // Only .ui-icon is an icon. An svg with no such class is a chart or a
      // logo - the analytics sparkline is 754px wide and is meant to be - and
      // measuring those against a glyph limit reports the chart as a fault.
      return [...document.querySelectorAll('svg.ui-icon')]
        .map(s => {
          const r = s.getBoundingClientRect();
          return { cls: (s.getAttribute('class') || '').slice(0, 44),
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
  // Measured at 420px, where the settings nav is a disclosure and the toggle is
  // actually on screen. It used to be measured at the page's own 1440px viewport,
  // which is fine only while the nav collapses below that width. When the
  // threshold moved to 999px the toggle became display:none at 1440 and the caret
  // measured 0x0 - a real regression reported by a check that had been silently
  // measuring a hidden element for as long as it had been passing. A geometry
  // assertion is only worth what its element is actually visible for.
  await page.setViewport(420, 900);
  await page.goto(B + '/c/' + serverId + '/settings/roles', { waitMs: 2400 });
  await wait(1000);
  const caret = await page.eval(`
    const c = document.querySelector('.settings-nav__toggle-caret');
    if (!c) return { present: false };
    const r = c.getBoundingClientRect();
    return { present: true, w: Math.round(r.width), h: Math.round(r.height),
             hasBase: c.classList.contains('ui-icon'),
             toggleShown: !!document.querySelector('.settings-nav__toggle')
               && getComputedStyle(document.querySelector('.settings-nav__toggle')).display !== 'none' };
  `);
  ok('the settings disclosure toggle is visible at 420px', caret.toggleShown, caret);
  ok('the caret is rendered', caret.present, caret);
  if (caret.present) {
    ok('the caret keeps the base class that gives it a size', caret.hasBase, caret);
    ok('the caret is 14px wide, not hundreds', caret.w > 0 && caret.w <= 20, caret);
  }
  await page.setViewport(1440, 900);

  console.log('\n=== nothing overlays a message on a phone ===');
  // Three separate faults came from one mistake: a max-width media query
  // restating a selector the base stylesheet already owned, at equal specificity,
  // further down the file. On a phone that made every message paint its hover bar
  // over its own text, and drew the header's action buttons straight through the
  // channel name. Neither throws and neither fails a syntax check; both are only
  // visible if something measures the rendered result on a narrow viewport.
  for (const [w, h] of [[390, 844], [360, 740]]) {
    await page.setViewport(w, h);
    await page.goto(B + '/c/' + serverId, { waitMs: 2400 });
    await wait(700);
    await page.eval(`const b = document.querySelector('.ctx-channel'); if (b) b.click(); return 1;`);
    await wait(2400);

    // The bars must be hidden, not merely small.
    const bars = await page.eval(`
      const bars = [...document.querySelectorAll('.msg .msg-hoverbar')];
      return { total: bars.length, visible: bars.filter(b => getComputedStyle(b).display !== 'none').length };
    `);
    ok(w + ': no message shows its hover bar untouched (' + bars.visible + '/' + bars.total + ')',
      bars.total > 0 && bars.visible === 0, bars);

    // And the header's controls must not sit on top of its own title.
    const head = await page.eval(`
      const title = document.querySelector('.context-title');
      const acts = document.querySelector('.context-actions');
      if (!title || !acts) return { none: true };
      const t = title.getBoundingClientRect();
      const a = acts.getBoundingClientRect();
      return {
        overlap: Math.round(Math.min(t.right, a.right) - Math.max(t.left, a.left)),
        titleW: Math.round(t.width),
        actsRight: Math.round(a.right), vw: window.innerWidth,
      };
    `);
    ok(w + ': the header actions do not overlap the title', !head.none && head.overlap <= 1, head);
    ok(w + ': the title is not truncated to nothing', !head.none && head.titleW > 40, head);
    ok(w + ': the actions stay inside the viewport', !head.none && head.actsRight <= head.vw, head);
  }
  await page.setViewport(1440, 900);

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

  // Settings navigation has to be reachable at every width that can run it.
  // The nav used to collapse into a phone-style disclosure below 1699px, so an
  // ordinary 1440px laptop showed one section name, a filter box and a sign-out
  // link and no route at all to Security, Privacy, Notifications, Appearance,
  // Backend or Updates. Eleven sections, one reachable. The disclosure is right
  // on a phone and wrong on a laptop, so this checks both ends.
  console.log('\n=== every settings section is reachable ===');
  for (const [w, label] of [[1440, 'desktop'], [820, 'tablet'], [390, 'phone']]) {
    await page.setViewport(w, 900);
    await page.goto(B + '/settings', { waitMs: 2200 });
    await wait(800);
    const nav = await page.eval(`
      const items = [...document.querySelectorAll('.settings-nav__item')];
      const visible = items.filter(a => {
        if (a.hidden) return false;
        let n = a;
        while (n && n !== document.body) {
          if (getComputedStyle(n).display === 'none') return false;
          n = n.parentElement;
        }
        return true;
      });
      return { total: items.length, visible: visible.length,
               collapsed: !!document.querySelector('.settings-nav__groups')
                 && getComputedStyle(document.querySelector('.settings-nav__groups')).display === 'none',
               labels: visible.map(a => a.textContent.trim()).slice(0, 12) };
    `);
    if (w === 390) {
      // On a phone the disclosure is correct. What matters is that the toggle
      // exists, so the list can be opened at all.
      ok('phone: settings navigation is a disclosure you can open', nav.total > 1, nav);
    } else {
      ok(label + ': all settings sections are on screen without a tap (' + nav.visible + '/' + nav.total + ')',
        nav.total > 1 && nav.visible === nav.total, nav);
    }
  }
} finally {
  await page.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (bad.length) console.log('failed: ' + bad.join(' | '));
process.exit(fail ? 1 : 0);