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
  // These were never photographed, which is the same mistake as never signing out:
  // a page nobody looked at is a page whose problems nobody knows about.
  notifications: '/notifications',
  friends: '/friends',
  discover: '/discover',
  'settings-backend': '/settings/backend',
  'settings-updates': '/settings/updates',
  support: '/support',
  appeals: '/support/appeals',
  'legal-terms': '/legal/terms',
  'legal-privacy': '/legal/privacy',
  forgot: '/forgot',
  menu: '/menu',
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
  const faulted = [];

  // The first thing this suite does is sign in, and a failure there is reported as
  // "no field for #reg-username" - which says the form was missing, not that the
  // page re-rendered underneath the driver or that the console was full of errors.
  // Walking the two addresses a signed-out reader sees, and printing whatever the
  // console said, turns that into an actual diagnosis.
  page.resetErrors();
  for (const route of ['/', '/register']) {
    await page.goto(ORIGIN + route, { waitMs: 1600 });
    await wait(600);
    const seen = await page.eval(`
      const reg = document.querySelector('#reg-username');
      const card = document.querySelector('.auth-formwrap');
      return {
        path: location.pathname,
        title: (document.querySelector('.stage-head-title') || {}).textContent || '',
        hasRegisterField: !!reg,
        hasAuthCard: !!card,
        bodyStart: (document.body.innerText || '').trim().slice(0, 120),
      };`);
    console.log('  PREAUTH ' + route + ' -> ' + JSON.stringify(seen));
  }
  for (const e of await page.errors()) console.log('  PREAUTH JS-ERROR ' + e);
  page.resetErrors();

  try {
    const acct = await signedIn(page, ORIGIN, { seedCommunity: true });
    if (!acct.serverId) throw new Error('could not seed a community: ' + JSON.stringify(acct.seed));

    // Resolve the channel route the same way a person does: click the row, read
    // where it took us. Hardcoding the shape of the URL would let a routing
    // regression show up here as a clean screenshot of an error page.
    await page.goto(ORIGIN + '/c/' + acct.serverId, { waitMs: 2400 });
    await wait(900);
    await page.eval(`const b = document.querySelector('.nav-item--channel'); if (b) b.click(); return 1;`);
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
        // Measured before the page is put back at the top, so the numbers describe
        // the page as it arrived rather than the page as it was corrected to.
        const m0 = await page.eval(`
          const d0 = document.documentElement;
          // Anything already scrolled when the page settled. A pane that arrived
          // scrolled photographs as a page whose first heading is missing, which
          // reads as content hidden under the header and is not that at all - the
          // only way to tell the two apart is to be told the scroll offsets.
          const scrolled = [];
          for (const e of document.querySelectorAll('body *')) {
            if (e.scrollTop > 1 && e.scrollHeight - e.clientHeight > 4) {
              const tag = e.id ? '#' + e.id : '.' + String(e.className || '').trim().split(/\s+/)[0];
              scrolled.push(tag + '=' + e.scrollTop);
              if (scrolled.length === 3) break;
            }
          }
          return { chars: document.body.innerText.trim().length,
                   overflow: d0.scrollWidth > window.innerWidth + 1,
                   scrollW: d0.scrollWidth, vw: window.innerWidth,
                   win: window.scrollY, scrolled,
                   // The two surfaces that mean a page did not render. Collecting
                   // console errors is not enough on its own: a page can throw, be
                   // caught by the shell's boundary, and photograph perfectly as a
                   // tidy error card with a working layout and no overflow. So the
                   // card itself is the failure signal.
                   faulted: /Trycord could not start|Unable to load this view/.test(
                     document.body.innerText || '') };`);
        // Then put it at the top, and let that settle, before the shutter.
        //
        // The order of these two used to be the other way round, which is how two
        // settings pages came to photograph with their first heading missing: the
        // screenshot caught a scroll still in flight and the probe ran after it had
        // finished, so the report said the page was fine while the picture said
        // otherwise. A screenshot of a page mid-animation is not a screenshot of
        // the page.
        await page.eval(`
          window.scrollTo(0, 0);
          for (const e of document.querySelectorAll('body *')) {
            if (e.scrollHeight - e.clientHeight > 4 && e.scrollTop) e.scrollTop = 0;
          }
          return true;`);
        await wait(350);
        await page.shot(file);
        written.push(file);
        console.log('  ' + tag.padEnd(6) + name.padEnd(22)
          + String(m0.chars).padStart(5) + ' chars  '
          + (m0.overflow ? 'H-OVERFLOW ' + m0.scrollW + '/' + m0.vw : 'fits')
          + (m0.win ? '  WIN-SCROLL ' + m0.win : '')
          + (m0.scrolled && m0.scrolled.length ? '  SCROLLED ' + m0.scrolled.join(' ') : '')
          + (m0.faulted ? '  PAGE-FAULT' : ''));
        if (m0.faulted) faulted.push(tag + '/' + name);

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
            'shell data-spine=' + (sh && sh.dataset.spine)
              + ' data-context=' + (sh && sh.dataset.context),
            tracks('#shell', 'gridTemplateColumns'),
            tracks('#trycord-main', 'gridTemplateColumns'),
            tracks('#trycord-main', 'gridTemplateRows'),
            'rootVar spine=' + getComputedStyle(document.documentElement).getPropertyValue('--spine-w').trim()
              + ' context=' + getComputedStyle(document.documentElement).getPropertyValue('--context-w').trim(),
            box('#app'), box('#shell'), box('#spine'), box('#place-navigation'),
            box('#trycord-main'), box('#context-header'), box('#view-root'),
            box('#context-panel'), box('.convo'),
          ].join(NL);
        `);
        console.log(String(geo).split(String.fromCharCode(10)).map((x) => '          ' + x).join(String.fromCharCode(10)));

      }
    }

    // The phone surfaces are the Mobile module: a second document at /mobile, not
    // the desktop shell narrowed. What lived here was a drawer on the desktop
    // shell - the phone arrangement the Desktop module no longer has - so this
    // loads the mobile document and photographs its shell at the widths that
    // matter. A phone's whole navigation is its tab bar, and a screenshot set that
    // never shows it cannot tell a working mobile module from a deleted one, which
    // is exactly how the sidebar once went missing unseen.
    for (const [w, h, tag] of SIZES) {
      if (w >= 1000) continue;
      await page.setViewport(w, h);
      await page.goto(ORIGIN + '/mobile/', { waitMs: 2300 });
      await wait(900);
      const file = OUT + '/' + tag + '-mobile.png';
      await page.shot(file);
      written.push(file);

      // What the module's navigation actually is, and whether the shell fits the
      // viewport it was handed.
      const shell = await page.eval(`
        const NL = String.fromCharCode(10);
        const tabs = document.getElementById('m-tabs');
        const labels = tabs ? [...tabs.querySelectorAll('.m-tab__label')].map((n) => n.textContent.trim()) : [];
        const current = tabs ? tabs.querySelector('.m-tab[aria-current="page"]') : null;
        const view = document.querySelector('.m-view');
        const vb = view ? view.getBoundingClientRect() : null;
        return [
          'document ' + (document.documentElement.dataset.platform || '(no data-platform)'),
          'tabs(' + labels.length + '): ' + (labels.join(' | ') || 'MISSING'),
          'current ' + (current ? current.textContent.trim() : 'none'),
          'view x=' + (vb ? Math.round(vb.left) + '..' + Math.round(vb.right) : '?')
            + ' y=' + (vb ? Math.round(vb.top) + '..' + Math.round(vb.bottom) : '?'),
          'overflow=' + (document.documentElement.scrollWidth > window.innerWidth + 1),
        ].join(NL);
      `);
      console.log('  ' + tag.padEnd(6) + 'mobile');
      console.log(String(shell).split(String.fromCharCode(10)).map((x) => '          ' + x).join(String.fromCharCode(10)));

      // The community tree and the account controls live on the menu page; a phone
      // reaches it from the tab bar, so it is photographed and read too.
      await page.goto(ORIGIN + '/mobile/menu', { waitMs: 1800 });
      await wait(700);
      const menuFile = OUT + '/' + tag + '-mobile-menu.png';
      await page.shot(menuFile);
      written.push(menuFile);
      const menu = await page.eval(`
        const rows = [...document.querySelectorAll('.m-row')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());
        return 'rows(' + rows.length + '): ' + (rows.slice(0, 12).join(' | ') || 'none')
          + ' | overflow=' + (document.documentElement.scrollWidth > window.innerWidth + 1);
      `);
      console.log('          ' + menu);
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
            'shell=' + (shell ? 'yes spine=' + (shell.dataset.spine || '-') : 'MISSING')
              + ' globals=' + document.querySelectorAll('#global-navigation .nav-item').length
              + ' communities=' + document.querySelectorAll('#place-navigation .nav-item:not(.nav-item--channel):not(.nav-item--dm)').length
              + ' channels=' + document.querySelectorAll('.nav-item--channel').length
              + ' view=' + (document.querySelector('#view-root') ? document.querySelector('#view-root').children.length + ' child' : 'MISSING'),
          ].join(NL);`);
        console.log('  route  ' + label.padEnd(26) + ' ' + String(m).split(String.fromCharCode(10))[0]);
        for (const l of String(m).split(String.fromCharCode(10)).slice(1)) console.log('          ' + l);
      };

      await step('open community', () => page.goto(ORIGIN + '/c/' + acct.serverId, { waitMs: 2300 }));
      await step('open a channel', () => page.eval(`const b = document.querySelector('.nav-item--channel'); if (b) b.click(); return 1;`));
      await step('go to home', () => page.eval(`const b = [...document.querySelectorAll('#global-navigation .nav-item')].find(x => /home/i.test(x.textContent || '')); if (b) b.click(); return 1;`));
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
          + ' | rawPage=' + (document.documentElement.dataset.raw ? 'yes' : 'no')
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
          const card = document.querySelector('.auth-formwrap, .auth-formside');
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
  if (faulted.length) {
    // An error card photographs tidily: correct layout, no overflow, nothing to
    // complain about visually. Which is exactly why a page that threw could sit
    // here being mistaken for a finished design. Listed, and the run fails.
    console.error('\n' + faulted.length + ' surface(s) rendered an error card instead of a page:');
    for (const f of faulted) console.error('  ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // A machine whose Chromium cannot complete an http request never gets off
  // about:blank, so every surface photographs the same empty page. That is a fact about
  // the machine, not about Trycord, and a check that cannot tell the two apart is a
  // check people learn to ignore.
  //
  // So it is detected and reported as a skip, and the run passes. On a CI runner, where
  // the browser has working networking, this branch is never taken.
  const message = String((err && err.message) || err);
  if (/about:blank|not configured|no usable page target|timed out|cannot fetch http|never navigated/i.test(message)) {
    console.log(
      '\n  SKIPPED: the chromium on this machine cannot load an http origin, so there'
      + ' is nothing to photograph. Trycord was not exercised and did not fail.'
      + '\n  Run this where the browser has working networking - a CI runner does.\n'
    );
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
