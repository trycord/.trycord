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

const SIZES = [
  [1440, 900, 'desk'],
  [390, 844, 'phone'],
  [834, 1112, 'tablet'],
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
  } finally {
    await page.close();
  }
  console.log('\nwrote ' + written.length + ' screenshots to ' + OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
