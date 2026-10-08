// Sidebar rows must navigate, and the sidebar must describe the page it sits
// beside.
//
// The first was a dead button: rows were handed navigate('/' + path) for paths
// that already began with a slash, so the argument became '//friends'. That
// resolves as a protocol-relative URL - 'http://friends/' - and pushState
// refuses it with a SecurityError. The click threw and the page did not move.
//
// The second was /home describing itself as Direct messages, which put "No
// conversations yet" beside a feed full of conversations.

import { launch, waitForServer, signedIn } from './cdp.mjs';

const B = process.env.TC_ORIGIN || 'http://127.0.0.1:9975';
let pass = 0, fail = 0; const bad = [];
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; bad.push(n); console.log('  FAIL  ' + n + (x !== undefined ? '  <<< ' + JSON.stringify(x).slice(0, 300) : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await waitForServer(B + '/api/health');
const page = await launch({ width: 1440, height: 900 });
try {
  const { serverId } = await signedIn(page, B, { seedCommunity: true });
  ok('signed in with a community', !!serverId, serverId);

  console.log('\n=== every sidebar row navigates ===');
  // Each of these layouts renders a sidebar built from simpleListContext, which
  // is where the '//' was built.
  for (const [from, rows] of [
    ['/friends', ['All friends', 'Add friend']],
    ['/notifications', ['All notifications']],
  ]) {
    await page.goto(B + from, { waitMs: 2400 });
    await wait(900);
    const present = await page.eval(`
      return [...document.querySelectorAll('#place-navigation button')].map(e => (e.innerText||'').trim());`);
    ok(from + ' renders a sidebar', present.length > 0, present);

    for (const label of rows) {
      page.resetErrors();
      const clicked = await page.eval(`
        const b = [...document.querySelectorAll('#place-navigation button')].find(e => (e.innerText||'').trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;`);
      await wait(1800);
      const after = await page.eval(`return { path: location.pathname, host: location.host };`);
      const errs = (await page.errors()).filter((e) => !/favicon|DevTools/i.test(e));

      ok(from + ': "' + label + '" exists', clicked, present);
      ok(from + ': "' + label + '" throws nothing', errs.length === 0, errs.slice(0, 2));
      ok(from + ': "' + label + '" stays on this origin', after.host === new URL(B).host, after);
      ok(from + ': "' + label + '" resolved to a real route', after.path.startsWith('/'), after);
    }
  }

  console.log('\n=== /home has a sidebar that describes Home ===');
  await page.goto(B + '/home', { waitMs: 2400 });
  await wait(1100);
  const homeSide = await page.eval(`
    const nav = document.querySelector('#place-navigation');
    return {
      hasSidebar: !!nav && nav.dataset.empty !== 'true',
      heading: (nav.querySelector('.ctx-head__title')||{}).innerText,
      rows: [...nav.querySelectorAll('.row--nav')].map(r => ({
        label: ((r.querySelector('.nv-label')||{}).innerText||'').trim(),
        active: r.classList.contains('active'),
      })),
      headerTitle: (document.querySelector('.context-title')||{}).innerText,
    };`);
  ok('/home has a sidebar', homeSide.hasSidebar, homeSide);
  ok('it is not claiming to be Direct messages', homeSide.heading !== 'Direct messages', homeSide);
  ok('it is titled Home', homeSide.heading === 'Home', homeSide);
  ok('the page and sidebar agree', homeSide.heading === homeSide.headerTitle, homeSide);
  console.log('  sidebar rows: ' + JSON.stringify(homeSide.rows.map((r) => r.label)));

  const labels = homeSide.rows.map((r) => r.label);
  for (const want of ['Direct messages', 'Friends', 'Notifications']) {
    ok('it lists ' + want, labels.includes(want), labels);
  }
  ok('Home is the active row', homeSide.rows.some((r) => r.active && r.label === 'Home'), homeSide.rows);

  console.log('\n=== those rows work too ===');
  for (const [label, expect] of [
    ['Direct messages', '/dms'],
    ['Friends', '/friends'],
    ['Notifications', '/notifications'],
  ]) {
    // Go back to /home before each one. The first click navigates away, and the
    // sidebar then belongs to the page just landed on - so without this the
    // second and third look for their row on a sidebar that has never got one.
    await page.goto(B + '/home', { waitMs: 2200 });
    await wait(900);
    page.resetErrors();
    const clicked = await page.eval(`
      const b = [...document.querySelectorAll('#place-navigation button')].find(e => {
        const l = ((e.querySelector('.nv-label')||{}).innerText)||'';
        return l.trim() === ${JSON.stringify(label)};
      });
      if (!b) return false; b.click(); return true;`);
    await wait(2000);
    const after = await page.eval(`return { path: location.pathname, host: location.host };`);
    const errs = (await page.errors()).filter((e) => !/favicon|DevTools/i.test(e));
    ok('Home sidebar -> ' + label + ' works', clicked && errs.length === 0, { clicked, errs: errs.slice(0, 2) });
    ok('Home sidebar -> ' + label + ' lands on its page', after.path === expect, after);
  }

  console.log('\n=== no sidebar claims to be a different page ===');
  for (const [route, expect] of [
    ['/dms', 'Direct messages'],
    ['/friends', 'Friends'],
    ['/notifications', 'Notifications'],
    ['/home', 'Home'],
  ]) {
    await page.goto(B + route, { waitMs: 2200 });
    await wait(800);
    const pair = await page.eval(`
      const nav = document.querySelector('#place-navigation');
      return { side: (nav.querySelector('.ctx-head__title')||{}).innerText,
               page: (document.querySelector('.context-title')||{}).innerText };`);
    ok(route + ': sidebar says "' + expect + '"', pair.side === expect, pair);
  }

  console.log('\n=== the root path behaves like /home ===');
  await page.goto(B + '/', { waitMs: 2200 });
  await wait(900);
  const rootSide = await page.eval(`
    const nav = document.querySelector('#place-navigation');
    return { side: (nav.querySelector('.ctx-head__title')||{}).innerText, path: location.pathname };`);
  ok('/ also gets the Home sidebar', rootSide.side === 'Home', rootSide);

  console.log('\n=== a community sidebar still describes the community ===');
  await page.goto(B + '/c/' + serverId, { waitMs: 2600 });
  await wait(1200);
  const communitySide = await page.eval(`
    const nav = document.querySelector('#place-navigation');
    return { heading: ((nav.querySelector('.ctx-switcher__name')||{}).innerText)||'',
             channels: [...nav.querySelectorAll('.ctx-channel__name')].map(c => c.innerText) };`);
  ok('the community sidebar names the community', communitySide.heading === 'The Foundry', communitySide);
  ok('and lists its channels', communitySide.channels.length > 0, communitySide);
} finally {
  await page.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (bad.length) console.log('failed: ' + bad.join(' | '));
process.exit(fail ? 1 : 0);