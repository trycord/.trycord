// Photograph an emitted surface in the real Chromium, through the same bridge
// layout.mjs uses. This machine's Chromium cannot fetch http, so the finished
// DOM from check-render --emit-dom and the real stylesheet are injected into
// about:blank instead of being loaded over the wire.
//
//   node scripts/browser/see.mjs <dom-dir> <pageId[,pageId...]> [--phone] [--theme=light]
//
// Writes PNGs to /tmp/opencode/shots/ so the actual pixels can be looked at.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch } from './bridge.mjs';

const CLIENT = path.join(process.cwd(), '..', 'frontend');
const OUT = '/tmp/opencode/shots';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const domDir = positional[0];
const ids = positional[1] || '';
const widthArg = args.includes('--phone') ? 390 : 1440;
const heightArg = args.includes('--phone') ? 844 : 900;
const themeArg = (args.find((a) => a.startsWith('--theme=')) || '').split('=')[1] || null;
const dark = !args.includes('--light');

async function main() {
  const manifestPath = path.join(domDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const wanted = ids ? ids.split(',') : manifest.map((m) => m.id);
  mkdirSync(OUT, { recursive: true });

  const css = readFileSync(path.join(CLIENT, 'css/app.css'), 'utf8');
  const head = `<style>${css}</style>`;
  const noMotion = '<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>';
  const themeScript = themeArg
    ? `<script>document.documentElement.dataset.theme=${JSON.stringify(themeArg)};</script>`
    : '';

  const b = await launch();
  if (!b) { console.log('no chromium'); return; }
  try {
    for (const id of wanted) {
      const entry = manifest.find((m) => m.id === id);
      if (!entry) { console.log('no such surface: ' + id); continue; }
      const html = readFileSync(entry.file, 'utf8');
      const stripped = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
      // theme script goes at the end of head, after the stylesheet's inline style
      const withHead = stripped.replace('</head>', head + noMotion + themeScript + '</head>');
      await b.send('Page.navigate', { url: 'about:blank' });
      await new Promise((r) => setTimeout(r, 60));
      await b.send('Emulation.setDeviceMetricsOverride', {
        width: widthArg, height: heightArg, deviceScaleFactor: 1, mobile: false,
      });
      await b.eval('document.open(); document.write(' + JSON.stringify(withHead) + '); document.close(); true');
      if (themeArg) await b.eval('document.documentElement.dataset.theme = ' + JSON.stringify(themeArg) + '; true');
      await new Promise((r) => setTimeout(r, 120));
      const shot = await b.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, (themeArg ? themeArg + '-' : '') + (widthArg < 600 ? 'phone-' : 'desk-') + id + '.png');
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('wrote ' + file);
    }
  } finally {
    await b.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
