// Dump what the injected surface actually computes to, since this model cannot
// view the PNG. Geometry + computed colour for the shell regions and a sample of
// view content, at one width.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launch } from './bridge.mjs';

const CLIENT = path.join(process.cwd(), '..', 'frontend');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const domDir = positional[0];
const ids = (positional[1] || 'home').split(',');
const phone = process.argv.includes('--phone');
const width = phone ? 390 : 1440;
const height = phone ? 844 : 900;
const theme = (process.argv.find((a) => a.startsWith('--theme=')) || '').split('=')[1] || null;

const PROBE = String.raw`(() => {
  const out = [];
  const NL = '\n';
  const cs = (el) => el ? getComputedStyle(el) : null;
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return sel + ' = MISSING';
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return sel + '  x=' + Math.round(r.left) + '..' + Math.round(r.right)
      + ' y=' + Math.round(r.top) + '..' + Math.round(r.bottom)
      + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
      + '  bg=' + s.backgroundColor + ' radius=' + s.borderRadius
      + ' disp=' + s.display;
  };
  const root = getComputedStyle(document.documentElement);
  out.push('platform=' + (document.documentElement.dataset.platform || 'desktop')
    + ' theme=' + (document.documentElement.dataset.theme || '-')
    + ' viewport=' + document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight);
  out.push('vars: --app-bg=' + root.getPropertyValue('--app-bg').trim()
    + ' --panel=' + root.getPropertyValue('--panel').trim()
    + ' --rail-w=' + root.getPropertyValue('--rail-w').trim()
    + ' --spine-w=' + root.getPropertyValue('--spine-w').trim()
    + ' --context-w=' + root.getPropertyValue('--context-w').trim());
  out.push(box('body'));
  for (const sel of ['#app','#shell','#community-rail','#spine','#place-navigation','#global-navigation','#trycord-main','#context-header','#view-root','#context-panel','.ws','.stage','.stage-head']) {
    out.push(box(sel));
  }
  // Colour inventory: distinct computed colours actually painted by text.
  const colors = {};
  for (const el of document.querySelectorAll('#view-root *, body > *')) {
    const s = getComputedStyle(el);
    if (!s) continue;
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') colors['bg:' + s.backgroundColor] = (colors['bg:' + s.backgroundColor]||0)+1;
    if (el.children.length === 0 && (el.textContent||'').trim()) colors['fg:' + s.color] = (colors['fg:' + s.color]||0)+1;
  }
  // Scrollability: a body that overflows its box but cannot scroll is a page the
  // reader can never reach the bottom of.
  const scroll = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return sel + ' = MISSING';
    const s = getComputedStyle(e);
    return sel + '  client=' + e.clientHeight + ' scroll=' + e.scrollHeight
      + ' overflowY=' + s.overflowY
      + (e.scrollHeight > e.clientHeight + 1 ? '  OVERFLOWS' : '  fits');
  };
  out.push('scroll:');
  for (const sel of ['html', 'body', '.ws', '.stage', '.screen', '.stage-body', '#view-root']) {
    out.push('  ' + scroll(sel));
  }
  const vr0 = document.querySelector('#view-root');
  if (vr0) {
    const first = vr0.firstElementChild;
    out.push('  view-root first child: ' + (first ? first.className || first.tagName : 'none')
      + ' h=' + (first ? Math.round(first.getBoundingClientRect().height) : 0));
    out.push('  reachable: ' + (vr0.scrollHeight <= vr0.clientHeight + 1 ? 'yes (fits)'
      : getComputedStyle(vr0).overflowY === 'auto' || getComputedStyle(vr0).overflowY === 'scroll' ? 'yes (scrolls)' : 'NO'));
  }
  out.push('colours:');
  for (const [k,v] of Object.entries(colors).sort((a,b)=>b[1]-a[1]).slice(0,14)) out.push('  ' + v + 'x  ' + k);
  // A text map of the main view region, for structure.
  const vr = document.querySelector('#view-root');
  if (vr) {
    out.push('view text: ' + JSON.stringify((vr.innerText||'').replace(/\s+/g,' ').trim().slice(0, 300)));
    out.push('view classes: ' + [...vr.querySelectorAll('*')].slice(0,40).map(e=>e.tagName.toLowerCase()+'.'+String(e.className||'').split(/\s+/).slice(0,2).join('.')).join(' '));
  }
  return out.join(NL);
})()`;

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(domDir, 'manifest.json'), 'utf8'));
  const css = readFileSync(path.join(CLIENT, 'css/app.css'), 'utf8');
  const head = '<style>' + css + '</style>';
  const themeScript = theme ? '<script>document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';</script>' : '';
  const b = await launch();
  if (!b) { console.log('no chromium'); return 1; }
  try {
    for (const id of ids) {
      const entry = manifest.find((m) => m.id === id);
      if (!entry) { console.log('no such surface: ' + id); continue; }
      const html = readFileSync(entry.file, 'utf8')
        .replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
      const withHead = html.replace('</head>', head + themeScript + '</head>');
      await b.send('Page.navigate', { url: 'about:blank' });
      await new Promise((r) => setTimeout(r, 50));
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await b.eval('document.open(); document.write(' + JSON.stringify(withHead) + '); document.close(); true');
      if (theme) await b.eval('document.documentElement.dataset.theme = ' + JSON.stringify(theme) + '; true');
      await new Promise((r) => setTimeout(r, 100));
      console.log('\n==== ' + id + ' @' + width + ' ====');
      console.log(await b.eval(PROBE));
    }
  } finally { await b.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
