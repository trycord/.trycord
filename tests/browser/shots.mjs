// Photographs every surface at the sizes that matter and writes them to
// ./shots/. Not an assertion suite - it fails only if it cannot run, because a
// missing screenshot is the point.
//
// This machine's chromium will not fetch http, so this is built to run on a CI
// runner (or anywhere with a working browser). Upload the result as an artifact
// and the screenshots can be looked at, which static source reading cannot do.
//
//   node shots.mjs                    every surface, desktop and phone
//   node shots.mjs channel settings   only the named ones
import { launch, waitForServer, signedIn } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const ORIGIN = process.env.TC_ORIGIN || 'http://127.0.0.1:9975';
const OUT = process.env.TC_SHOTS || new URL('./shots/', import.meta.url).pathname;

// Desktop first and at every width that has ever broken something, because the
// point of shooting is to catch the one nobody reasoned about. 1280 is a small
// laptop, 1920 is the common desktop, and 2560/3440 are the ultrawide sizes where
// a workspace stops expanding and starts leaving voids.
const SIZES = [
  [1280, 720, 'desk-1280'],
  [1920, 1080, 'desk-1920'],
  [2560, 1440, 'desk-2560'],
  [3440, 1440, 'desk-3440'],
  [1440, 900, 'desk'],
  [834, 1112, 'tablet'],
  [390, 844, 'phone'],
  [360, 740, 'small'],
];

// Only routes that exist for a seeded owner. Anything needing a second account
// or a live socket is deliberately absent rather than captured broken.
const SURFACES = {
  login: '/login',
  register: '/register',
  home: '/home',
  dms: '/dms',
  settings: '/settings',
  'settings-appearance': '/settings/appearance',
  'settings-privacy': '/settings/privacy',
  'settings-notifications': '/settings/notifications',
  'settings-account': '/settings/account',
  'settings-security': '/settings/security',
  channel: null, // resolved at runtime: the seeded channel
  'community-settings': null,
  roles: null,
  members: null,
  'community-bans': null,
  invite: null,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const only = process.argv.slice(2);
  mkdirSync(OUT, { recursive: true });
  await waitForServer(ORIGIN + '/api/health');

  // A cold runner sometimes starts chromium without exposing a page target for a
  // while. That is the machine, not the client, and losing a whole screenshot set
  // to it would be the wrong trade - so try again with a different debugging port
  // before giving up.
  let page = null;
  for (let attempt = 1; attempt <= 3 && !page; attempt++) {
    try {
      page = await launch({ width: 1440, height: 900, port: 9640 + attempt });
    } catch (err) {
      console.warn('  launch attempt ' + attempt + ' failed: ' + err.message);
      if (attempt === 3) throw err;
      await wait(3000);
    }
  }
  const written = [];
  try {
    const acct = await signedIn(page, ORIGIN, { seedCommunity: true });
    if (!acct.serverId) throw new Error('could not seed a community: ' + JSON.stringify(acct.seed));

    // Resolve the channel route the same way a person does: click the row, read
    // where it took us. Hardcoding the shape of the URL would let a routing
    // regression show up here as a clean screenshot of an error page.
    await page.goto(ORIGIN + '/c/' + acct.serverId, { waitMs: 2400 });
    await wait(900);
    await page.eval(`const b = document.querySelector('.ctx-channel'); if (b) b.click(); return 1;`);
    await wait(2800);
    const channelRoute = await page.eval('return location.pathname;');
    if (!channelRoute || channelRoute.endsWith('/c/' + acct.serverId)) {
      throw new Error('the channel row did not navigate; got ' + channelRoute);
    }

    const routes = { ...SURFACES, channel: channelRoute };
    const base = '/c/' + acct.serverId;
    routes['community-settings'] = base + '/settings/overview';
    routes.roles = base + '/settings/roles';
    routes.members = base + '/settings/members';
    routes['community-bans'] = base + '/settings/bans';
    routes.invite = base + '/invite';

    for (const [w, h, tag] of SIZES) {
      await page.setViewport(w, h);
      for (const [name, route] of Object.entries(routes)) {
        if (only.length && !only.includes(name)) continue;
        if (!route) continue;
        // Cleared before the navigation, so what is read back belongs to this
        // surface rather than to the one before it.
        page.resetErrors();
        await page.goto(ORIGIN + route, { waitMs: 2300 });
        await wait(750);
        const file = OUT + '/' + tag + '-' + name + '.png';
        await page.shot(file);
        written.push(file);
        // Shell geometry. Guessing at a grid from a screenshot is how three
        // rounds of "it still looks wrong" happened; this reports the numbers.
        const m0 = await page.eval(`
          const d0 = document.documentElement;
          return { chars: document.body.innerText.trim().length,
                   overflow: d0.scrollWidth > window.innerWidth + 1,
                   scrollW: d0.scrollWidth, vw: window.innerWidth };`);
        console.log('  ' + tag.padEnd(6) + name.padEnd(22)
          + String(m0.chars).padStart(5) + ' chars  '
          + (m0.overflow ? 'H-OVERFLOW ' + m0.scrollW + '/' + m0.vw : 'fits'));

        // A surface that paints correctly while throwing on every interaction is
        // not correct. The driver collects exceptions and console errors the whole
        // time; nothing was reading them.
        const errs = await page.errors();
        for (const e of [...new Set(errs)].slice(0, 4)) {
  console.log('          JS-ERROR ' + e.slice(0, 160));
        }
        const geo = await page.eval(`
          const box = (sel) => {
            const e = document.querySelector(sel);
            if (!e) return sel + ' = MISSING';
            const r = e.getBoundingClientRect();
            const cs = getComputedStyle(e);
            return sel + ' x=' + Math.round(r.left) + '..' + Math.round(r.right)
              + ' w=' + Math.round(r.width) + ' ' + cs.display
              + ' col=' + cs.gridColumnStart + '/' + cs.gridColumnEnd;
          };
          const tracks = (sel, prop) => {
            const e = document.querySelector(sel);
            return e ? sel + ' ' + prop + '=' + getComputedStyle(e)[prop] : '';
          };
          const sh = document.getElementById('shell');
          const NL = String.fromCharCode(10);
          return [
            'shell data-layout=' + (sh && sh.dataset.layout)
              + ' data-members=' + (sh && sh.dataset.members)
              + ' data-presentation=' + document.documentElement.dataset.presentation,
            tracks('.shell', 'gridTemplateColumns'),
            tracks('.main-content', 'gridTemplateColumns'),
            tracks('.main-content', 'gridTemplateRows'),
            tracks('.chat-environment', 'gridTemplateColumns'),
            'rootVar rail=' + getComputedStyle(document.documentElement).getPropertyValue('--ui-rail').trim()
              + ' members=' + getComputedStyle(document.documentElement).getPropertyValue('--ui-members').trim()
              + ' shellCols=' + getComputedStyle(document.documentElement).getPropertyValue('--ui-shell-cols').trim(),
            box('#app'), box('.shell'), box('.app-rail'), box('.main-content'),
            box('.context-header'), box('.chat-environment'), box('.view-root'),
            box('.member-sidebar'), box('.conversation'),
          ].join(NL);
        `);
        console.log(String(geo).split(String.fromCharCode(10)).map((x) => '          ' + x).join(String.fromCharCode(10)));

      }
    }

    // The navigation open, at the widths where it is not a docked column. On a
    // phone the community sidebar lives in this drawer, so a screenshot set that
    // never opens it cannot tell a working mobile shell from a deleted one - which
    // is exactly how the sidebar went missing once without the pictures showing it.
    for (const [w, h, tag] of SIZES) {
      if (w >= 1000) continue;
      await page.setViewport(w, h);
      await page.goto(ORIGIN + routes.channel, { waitMs: 2300 });
      await wait(900);
      await page.eval(`const b = document.querySelector('.nav-toggle'); if (b) b.click(); return 1;`);
      await wait(700);
      const file = OUT + '/' + tag + '-nav-open.png';
      await page.shot(file);
      written.push(file);

      // What is actually in the drawer, and whether all of it fits above the fold.
      const nav = await page.eval(`
        const NL = String.fromCharCode(10);
        const rail = document.querySelector('.app-rail');
        const r = rail ? rail.getBoundingClientRect() : null;
        const vis = (sel) => {
          const e = document.querySelector(sel);
          if (!e) return sel + ' = MISSING';
          const cs = getComputedStyle(e);
          const b = e.getBoundingClientRect();
          return sel + ' ' + cs.display + ' ' + cs.visibility
            + ' x=' + Math.round(b.left) + '..' + Math.round(b.right)
            + ' y=' + Math.round(b.top) + '..' + Math.round(b.bottom)
            + (b.height > 0 ? '' : ' ZERO-H');
        };
        const dests = [...document.querySelectorAll('.rail-nav')].map((e) => e.textContent.trim());
        const comms = [...document.querySelectorAll('.rail-community')].map((e) => e.textContent.trim());
        const chans = [...document.querySelectorAll('.ctx-channel')].map((e) => e.textContent.trim());
        const sb = document.querySelector('.context-sidebar');
        const sbb = sb ? sb.getBoundingClientRect() : null;
        const scrollable = [...document.querySelectorAll('.app-rail__items, .context-sidebar')]
          .map((e) => e.scrollHeight > e.clientHeight + 1
            ? e.className.split(' ')[0] + ' scrolls ' + e.scrollHeight + '/' + e.clientHeight : '');
        return [
          'drawer x=' + (r ? Math.round(r.left) + '..' + Math.round(r.right) : '?')
            + ' y=' + (r ? Math.round(r.top) + '..' + Math.round(r.bottom) : '?'),
          vis('.app-rail'), vis('.app-rail__items'), vis('.context-sidebar'),
          'community sidebar box x=' + (sbb ? Math.round(sbb.left) + '..' + Math.round(sbb.right) : '?')
            + ' y=' + (sbb ? Math.round(sbb.top) + '..' + Math.round(sbb.bottom) : '?'),
          'destinations(' + dests.length + '): ' + dests.join(' | '),
          'communities(' + comms.length + '): ' + comms.join(' | '),
          'channels(' + chans.length + '): ' + chans.join(' | '),
          scrollable.filter(Boolean).join('; ') || 'everything fits, no inner scroll',
        ].join(NL);
      `);
      console.log('  ' + tag.padEnd(6) + 'nav-open');
      console.log(String(nav).split(String.fromCharCode(10)).map((x) => '          ' + x).join(String.fromCharCode(10)));

      // Closing has to work as well as opening, or the drawer is a trap. Click the
      // scrim the way a person does and check the navigation went away and the
      // conversation underneath is whole again.
      await page.eval(`const b = document.querySelector('.nav-backdrop'); if (b) b.click(); return 1;`);
      await wait(700);
      const closed = await page.eval(`
        const rail = document.querySelector('.app-rail');
        const b = rail ? rail.getBoundingClientRect() : null;
        const header = document.querySelector('.context-header');
        const hb = header ? header.getBoundingClientRect() : null;
        return 'closed: rail x=' + (b ? Math.round(b.left) : '?')
          + ' width=' + (b ? Math.round(b.width) : '?')
          + ' | header x=' + (hb ? Math.round(hb.left) : '?')
          + ' w=' + (hb ? Math.round(hb.width) : '?')
          + ' | scrim=' + (document.querySelector('.nav-backdrop') ? 'present' : 'gone')
          + ' | composer=' + (document.querySelector('.composer') ? 'present' : 'MISSING')
          + ' | messages=' + document.querySelectorAll('.msg').length
          + ' | overflow=' + (document.documentElement.scrollWidth > window.innerWidth + 1);
      `);
      console.log('          ' + closed);

      // Switching community from the drawer: the sidebar under it has to become the
      // new community's, not the old one's with a new name on it.
      const before = await page.eval(`
        const sb = document.querySelector('.context-sidebar');
        return (sb ? sb.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) : 'MISSING');`);
      await page.eval(`const b = document.querySelector('.nav-toggle'); if (b) b.click(); return 1;`);
      await wait(600);
      const switched = await page.eval(`
        const comms = [...document.querySelectorAll('.rail-community')];
        const other = comms.find((e) => !e.classList.contains('is-active') && !e.classList.contains('rail-nav'));
        if (!other) return 'only one community seeded, switching not exercised';
        other.click();
        return 'clicked ' + other.textContent.trim();`);
      await wait(1800);
      const after = await page.eval(`
        const sb = document.querySelector('.context-sidebar');
        const rail = document.querySelector('.app-rail');
        return 'route=' + location.pathname
          + ' | rail=' + getComputedStyle(rail).display
          + ' | sidebar=' + (sb ? sb.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) : 'MISSING');`);
      console.log('          switch: ' + switched);
      console.log('            before: ' + before);
      console.log('            after:  ' + after);
      // Only meaningful when there was a second community to switch to. With one
      // seeded there is nothing to click, and warning about it every run trains
      // you to ignore the warning.
      if (!/only one community/.test(switched) && after.startsWith('route=/c/')
          && before && after.includes(before)) {
        console.log('          WARNING the sidebar did not change with the community');
      }
    }

    // Routing is the one thing that has to be right without a screenshot to look
    // at, so it gets checked by walking it rather than by photographing it.
    //
    // Each step states where it ended up and what it can see, because a router that
    // silently falls back to the home page passes a "did it navigate" assertion that
    // only looks at the network.
    {
      await page.setViewport(1440, 900);
      const step = async (label, action) => {
        await action();
        await wait(900);
        const m = await page.eval(`
          const NL = String.fromCharCode(10);
          const shell = document.getElementById('shell');
          return [
            'url=' + location.pathname + location.hash,
            'shell=' + (shell ? 'yes layout=' + (shell.dataset.layout || '-') : 'MISSING')
              + ' rails=' + document.querySelectorAll('.rail-nav').length
              + ' communities=' + document.querySelectorAll('.rail-community').length
              + ' channels=' + document.querySelectorAll('.ctx-channel').length
              + ' view=' + (document.querySelector('#view-root') ? document.querySelector('#view-root').children.length + ' child' : 'MISSING'),
          ].join(NL);`);
        console.log('  route  ' + label.padEnd(26) + ' ' + String(m).split(String.fromCharCode(10))[0]);
        for (const l of String(m).split(String.fromCharCode(10)).slice(1)) console.log('          ' + l);
      };

      await step('open community', () => page.goto(ORIGIN + '/c/' + acct.serverId, { waitMs: 2300 }));
      await step('open a channel', () => page.eval(`const b = document.querySelector('.ctx-channel'); if (b) b.click(); return 1;`));
      await step('go to home', () => page.eval(`const b = [...document.querySelectorAll('.rail-nav')].find(x => /home/i.test(x.dataset.label || '')); if (b) b.click(); return 1;`));
      await step('back', () => page.eval(`history.back(); return 1;`));
      await step('back again', () => page.eval(`history.back(); return 1;`));
      await step('forward', () => page.eval(`history.forward(); return 1;`));
      await step('deep link, cold', () => page.goto(ORIGIN + '/settings/security', { waitMs: 2300 }));
      await step('reload on that route', () => page.goto(ORIGIN + '/settings/security', { waitMs: 2300 }));
      await step('unknown route', () => page.goto(ORIGIN + '/nope-not-a-route', { waitMs: 1800 }));
      // 'shell=MISSING' on its own does not say whether the route fell back to home
      // or tore the app down, and those are very different bugs. Say what is on
      // screen.
      const unknown = await page.eval(`
        return 'text=' + JSON.stringify((document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120))
          + ' | authPage=' + (document.documentElement.hasAttribute('data-auth-page') ? 'yes' : 'no')
          + ' | token=' + (localStorage.getItem('trycord.token') ? 'present' : 'gone');`);
      console.log('          ' + unknown);
      // The route walk is the last thing that runs before the signed-out capture, so
      // anything it throws was being collected and never printed.
      for (const e of [...new Set(await page.errors())].slice(0, 5)) {
        console.log('          JS-ERROR ' + e.slice(0, 160));
      }
      page.resetErrors();

      const hash = await page.eval(`return location.hash || '(none)';`);
      if (hash !== '(none)') console.log('          WARNING a hash appeared in the URL: ' + hash);
    }

    // The auth pages, signed out. Everything else above is captured with a session,
    // which means /login and /register redirect to the app and the screenshots were
    // of the home page under those two names. The sign-in form is the first thing
    // anyone sees and the last thing that gets looked at, which is how a rule that
    // named a class the markup stopped using went unnoticed there.
    for (const [w, h, tag] of SIZES) {
      if (![1440, 390].includes(w)) continue;
      await page.setViewport(w, h);
      await page.eval(`localStorage.removeItem('trycord.token'); return 1;`);
      for (const route of ['/login', '/register']) {
        await page.goto(ORIGIN + route, { waitMs: 1800 });
        await wait(700);
        const file = OUT + '/' + tag + '-auth' + route.replace('/', '-') + '.png';
        await page.shot(file);
        written.push(file);
        const form = await page.eval(`
          const NL = String.fromCharCode(10);
          const card = document.querySelector('.auth-card, .auth-box, .card--auth');
          const f = document.querySelector('.auth-form');
          const b = card ? card.getBoundingClientRect() : null;
          return [
            'route=' + location.pathname
              + ' | card=' + (card ? card.className : 'MISSING')
              + ' w=' + (b ? Math.round(b.width) : '?')
              + ' h=' + (b ? Math.round(b.height) : '?'),
            'fields=' + document.querySelectorAll('.auth-form input, .auth-form select').length
              + ' submit=' + document.querySelectorAll('.auth-form button[type="submit"]').length
              + ' | text=' + JSON.stringify((document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70)),
          ].join(NL);
        `);
        console.log('  ' + tag.padEnd(6) + 'auth' + route.replace('/', '-'));
        console.log(String(form).split(String.fromCharCode(10)).map((x) => '          ' + x).join(String.fromCharCode(10)));
      }
    }
  } finally {
    await page.close();
  }
  console.log('\nwrote ' + written.length + ' screenshots to ' + OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
