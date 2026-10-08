// Measure the rendered surfaces in a real Chromium.
//
// What this is for.
//
// jsdom builds a correct DOM but has no layout engine, so every question about *space*
// is unanswerable there: is anything wider than the viewport, does the composer cover
// the last message, is a button big enough to hit with a thumb, and - the one that had no
// answer at all before this - what colour does this text actually end up on once the
// cascade has finished with it? A contrast check that reads the stylesheet can tell you
// two tokens are a bad pair. Only the browser can tell you that the thing you read is
// what got painted.
//
// The browser in this environment cannot complete an http request, so it does not make
// one. It is handed the finished DOM that scripts/check-render.js already produced and
// the real stylesheet, both injected into about:blank. Nothing here duplicates the
// application's rendering; there is one render and two measurements of it.
//
//   node scripts/browser/layout.mjs <dir>          the DOM directory from --emit-dom
//   node scripts/browser/layout.mjs <dir> --dump <pageId>
//
// Like the shot harness, this prints SKIPPED and exits 0 when the machine cannot run the
// browser. A check that reports a broken product on a machine that cannot run it is a
// check people learn to ignore.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { launch } from './bridge.mjs';

const CLIENT = path.join(process.cwd(), '..', 'frontend');

const args = process.argv.slice(2);
const domDir = args.find((a) => !a.startsWith('--'));
const dumpAt = args.includes('--dump') ? args[args.indexOf('--dump') + 1] : null;

// Three widths, and the two narrow ones are the reason this check exists: a layout that
// only works at desktop width is a layout that does not work.
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
];

// Runs in the page. Collects every measurement in one pass so the cost is one evaluate
// per surface rather than one per question.
const MEASURE = String.raw`
(() => {
  const out = { overflow: null, wide: [], small: [], advisory: [], tiny: [], invisible: [], lowContrast: [], covered: [] };

  const vw = document.documentElement.clientWidth;

  // 1. Does the page scroll sideways? This is the fault that makes a phone user pinch to
  //    zoom and gives up. It is also the one that a DOM-only check can never see.
  const scrollW = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0
  );
  if (scrollW > vw + 1) {
    // Attribute it. The widest offender is the one to fix; naming it is the difference
    // between a report and a complaint.
    let worst = null;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      const right = r.right + window.scrollX;
      if (right > vw + 1) {
        if (!worst || right > worst.right) {
          worst = {
            right: Math.round(right),
            width: Math.round(r.width),
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 60),
          };
        }
      }
    }
    out.overflow = { viewport: vw, scrollWidth: scrollW, worst };
  }

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Composite the background actually behind an element, walking ancestors until one is
  // not transparent. getComputedStyle alone gives you this element's background, which is
  // transparent for most text and tells you nothing about what it reads as.
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const backdrop = (el) => {
    let acc = null;
    let node = el;
    const stack = [];
    while (node && node.nodeType === 1) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a === 1) break;
      }
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    acc = base;
    // A gradient or a pseudo-element behind the text is not modelled here. That is a
    // known limit and it is why anything suspicious gets reported rather than asserted.
    return acc;
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const rgb = (c) => 'rgb(' + [c.r, c.g, c.b].map((v) => Math.round(v)).join(',') + ')';

  const describe = (el) => {
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return txt ? '"' + txt + '"' : '<' + el.tagName.toLowerCase() + '>';
  };

  // 2. Pointer targets.
  //
  //    The failure line is 24x24, which is WCAG 2.2 SC 2.5.8 Target Size (Minimum) at
  //    AA. My first version of this asserted the app's own 44px target (Apple's guideline) against
  //    everything, which is Apple's guideline, not the standard, and it failed 38-40px
  //    form inputs that are perfectly good controls. A check that encodes a stricter rule
  //    than the one it claims to enforce gets ignored when it goes off.
  //
  //    Below the line is a failure. Between the line and the comfortable target is reported, not failed:
  //    on a phone it is worth knowing about, but it is a design decision rather than a
  //    defect, and only the person who owns the design can make it.
  const rootStyle = getComputedStyle(document.documentElement);
  // The design system's own names. This read --t-hit and --t-fs-xs, which the palette
  // rebuild retired, so both fell through to their defaults: a 12px floor that the real
  // 11px --text-xs failed, and a 44px advisory line for a token that no longer exists.
  const hitDeclared = parseFloat(rootStyle.getPropertyValue('--target-min')) || 24;
  const AA = 24;
  const advisory = window.innerWidth < 820;
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"]')) {
    if (!visible(el)) continue;
    if (el.closest('[hidden]') || el.disabled) continue;
    const r = el.getBoundingClientRect();
    // Inline links inside a paragraph are not targets; they are text that happens to be
    // a link, and demanding 44px of them would be a rule about prose, not about UI.
    if (el.tagName === 'A' && el.closest('p, li.tiny, .small, figcaption')) continue;
    // The skip link is *supposed* to be off screen until it takes focus. That is the
    // whole design of it, and it is verified by keyboard order rather than by geometry,
    // so measuring its box reports a control that is working exactly as intended.
    if (el.classList.contains('skip-link')) continue;
    const record = {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 50),
      w: Math.round(r.width), h: Math.round(r.height),
      limit: AA, label: describe(el),
    };
    if (r.height < AA - 0.5 || r.width < AA - 0.5) {
      out.small.push(record);
    } else if (advisory && (r.height < hitDeclared - 0.5 || r.width < hitDeclared - 0.5)) {
      record.limit = hitDeclared;
      out.advisory.push(record);
    }
  }

  // 3. Text that is too small to read comfortably at the size it is actually rendered.
  const fsDeclared = parseFloat(rootStyle.getPropertyValue('--text-xs')) || 12;
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue;
    if (!visible(el)) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < fsDeclared - 0.5) {
      out.tiny.push({ fs: Math.round(fs * 10) / 10, limit: fsDeclared, label: describe(el) });
    }
  }

  // 4. Text that cannot be read because it is the colour of what is behind it, and text
  //    that is technically there but below the threshold on the surface it really landed
  //    on. Both are invisible to a token check and obvious to a person.
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue;
    if (!visible(el)) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const fgOn = fg.a < 1 ? over(fg, bg) : fg;
    const contrast = ratio(fgOn, bg);

    // 3:1 for large text, 4.5:1 otherwise, matching WCAG AA.
    const px = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;

    if (contrast < 1.15) {
      out.invisible.push({ label: describe(el), fg: rgb(fgOn), bg: rgb(bg), ratio: Math.round(contrast * 100) / 100 });
    } else if (contrast < need) {
      out.lowContrast.push({
        label: describe(el), fg: rgb(fgOn), bg: rgb(bg),
        ratio: Math.round(contrast * 100) / 100, need,
        px: Math.round(px), cls: String(el.className || '').slice(0, 40),
      });
    }
  }

  // 5. Fixed chrome sitting on top of content. A sticky composer or a bottom tab bar is
  //    the right answer for a phone; it is the wrong answer if the last row of a message
  //    list or a submit button ends up underneath it and cannot be reached.
  const fixed = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    fixed.push({ el, r });
  }
  for (const f of fixed) {
    for (const el of document.querySelectorAll('#view-root button, #view-root input, #view-root textarea, #view-row, #view-root .card')) {
      if (!visible(el)) continue;
      if (fixed.some((o) => o.el.contains(el))) continue;
      const r = el.getBoundingClientRect();
      const overlapY = Math.min(f.r.bottom, r.bottom) - Math.max(f.r.top, r.top);
      const overlapX = Math.min(f.r.right, r.right) - Math.max(f.r.left, r.left);
      if (overlapY > 4 && overlapX > 4) {
        out.covered.push({
          by: String(f.el.className || f.el.tagName).slice(0, 40),
          target: describe(el),
          byH: Math.round(f.r.height),
          overlap: Math.round(overlapY),
        });
        break;
      }
    }
  }

  out.counts = {
    elements: document.querySelectorAll('body *').length,
    textNodes: document.querySelectorAll('#view-root *').length,
  };
  out.scrollWidth = scrollW;
  out.viewport = vw;
  return out;
})()
`;

async function setWidth(b, w) {
  // mobile:false on purpose. With mobile:true this Chromium reports an initial
  // containing block 40px wider than the emulated width, so window.innerWidth came back
  // as 430 for a 390 viewport and every position:fixed element was measured against the
  // wrong box. That produced an overflow report for a page that does not have one - and
  // nearly sent me to fix a bug that was in the harness. A narrow window is what these
  // widths actually are; device emulation is not needed to have one.
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: w.width,
    height: w.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function main() {
  if (!domDir) {
    console.error('usage: layout.mjs <dom-dir-from---emit-dom>');
    process.exit(2);
  }
  const manifestPath = path.join(domDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('no manifest.json in ' + domDir + ' - run check-render.js --emit-dom first');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  let b;
  try {
    b = await launch();
  } catch (e) {
    console.log('SKIPPED - chromium would not start here: ' + e.message.split('\n')[0]);
    process.exit(0);
  }
  if (!b) {
    console.log('SKIPPED - no chromium on this machine');
    process.exit(0);
  }

  const css = readFileSync(path.join(CLIENT, 'css/app.css'), 'utf8');
  // The inline CSP in index.html forbids inline style, and the stylesheet has to arrive as
  // an inline <style> because there is no network to fetch a link from. Stripping it here
  // changes nothing about the product: this document is not served by anything.
  const head = '<style>' + css + '</style>';
  let failures = 0;
  let assertions = 0;
  let advisoryTotal = 0;
  const AA_MIN = 24;

  try {
    for (const entry of manifest) {
      if (dumpAt && entry.id !== dumpAt) continue;
      const html = readFileSync(entry.file, 'utf8');
      const stripped = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');

      const rows = [];
      for (const w of WIDTHS) {
        await b.send('Page.navigate', { url: 'about:blank' });
        await new Promise((r) => setTimeout(r, 60));
        await setWidth(b, w);
        await b.eval(
          'document.open(); document.write(' + JSON.stringify(stripped.replace('</head>', head + '</head>'))
          + '); document.close(); true'
        );
        const m = await b.eval(MEASURE);
        rows.push({ w, m });

        if (dumpAt) {
          console.log('\n  ==== ' + entry.id + ' @ ' + w.name + ' (' + w.width + 'px) ====');
          console.log('    viewport ' + m.viewport + '  scrollWidth ' + m.scrollWidth
            + '  elements ' + m.counts.elements);
          if (m.overflow) {
            console.log('    OVERFLOW ' + m.overflow.scrollWidth + ' > ' + m.overflow.viewport
              + (m.overflow.worst ? '  widest: <' + m.overflow.worst.tag + ' class="'
                + m.overflow.worst.cls + '"> ' + m.overflow.worst.width + 'px' : ''));
          }
          for (const s of m.small.slice(0, 6)) {
            console.log('    target ' + s.w + 'x' + s.h + ' < ' + s.limit + '  ' + s.label
              + '  .' + s.cls);
          }
          for (const t of m.tiny.slice(0, 4)) {
            console.log('    text ' + t.fs + 'px < ' + t.limit + 'px  ' + t.label);
          }
          for (const c of m.lowContrast.slice(0, 6)) {
            console.log('    contrast ' + c.ratio + ':1 < ' + c.need + ':1  ' + c.label
              + '  ' + c.fg + ' on ' + c.bg);
          }
          for (const v of m.invisible.slice(0, 4)) {
            console.log('    INVISIBLE ' + v.label + '  ' + v.fg + ' on ' + v.bg);
          }
          for (const cv of m.covered.slice(0, 4)) {
            console.log('    covered by .' + cv.by + ' (' + cv.overlap + 'px)  ' + cv.target);
          }
        }
      }

      if (dumpAt) continue;

      // A horizontal scrollbar is a failure at every width.
      assertions++;
      const over = rows.filter((r) => r.m.overflow);
      if (over.length) {
        failures++;
        const first = over[0];
        const worst = first.m.overflow.worst;
        console.log('    FAIL ' + entry.id + ' scrolls sideways at '
          + over.map((r) => r.w.name).join(', ')
          + '  <- ' + over.map((r) => r.m.overflow.scrollWidth + ' > ' + r.m.overflow.viewport).join(', ')
          + (worst ? '  widest: <' + worst.tag + ' class="' + worst.cls + '"> ' + worst.width + 'px' : ''));
      }

      // Reported, not failed. These are between the 24px AA line and this codebase's own
      // 44px preference, on a phone, where a thumb is the only pointer. Worth seeing in
      // the log; not this check's call to fail on.
      if (!dumpAt) {
        const adv = rows.flatMap((r) => r.m.advisory.map((a) => ({ ...a, at: r.w.name })));
        if (adv.length) {
          const seen = new Set();
          const uniq = adv.filter((a) => {
            const k = a.tag + '.' + a.cls + a.label;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          advisoryTotal += adv.length;
          console.log('    note ' + entry.id + ' has ' + adv.length + ' target(s) between '
            + AA_MIN + 'px and ' + uniq[0].limit + 'px on a phone  <- '
            + uniq.slice(0, 2).map((a) => a.label + ' ' + a.w + 'x' + a.h).join(' | '));
        }
      }

      // A target below the AA line is a failure.
      assertions++;
      const small = rows.flatMap((r) => r.m.small.map((s) => ({ ...s, at: r.w.name })));
      if (small.length) {
        failures++;
        const seen = new Set();
        const uniq = small.filter((s) => {
          const k = s.tag + '.' + s.cls + s.label;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        console.log('    FAIL ' + entry.id + ' has ' + small.length + ' unreachable target(s)  <- '
          + uniq.slice(0, 3).map((s) => s.label + ' ' + s.w + 'x' + s.h + ' @' + s.at
            + ' .' + s.cls).join(' | '));
      }

      // Text at the wrong colour is a failure. This is the assertion the token-level
      // contrast check cannot make, because only the browser knows what got painted.
      assertions++;
      const lc = rows.flatMap((r) => r.m.lowContrast.map((c) => ({ ...c, at: r.w.name })));
      if (lc.length) {
        failures++;
        const seen = new Set();
        const uniq = lc.filter((c) => {
          const k = c.label + c.fg + c.bg;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        console.log('    FAIL ' + entry.id + ' has ' + lc.length + ' low-contrast text(s)  <- '
          + uniq.slice(0, 3).map((c) => c.label + ' ' + c.ratio + ':1 (needs ' + c.need
            + ') ' + c.fg + ' on ' + c.bg).join(' | '));
      }

      assertions++;
      const inv = rows.flatMap((r) => r.m.invisible.map((c) => ({ ...c, at: r.w.name })));
      if (inv.length) {
        failures++;
        console.log('    FAIL ' + entry.id + ' has ' + inv.length + ' invisible text node(s)  <- '
          + inv.slice(0, 3).map((c) => c.label + ' ' + c.fg + ' on ' + c.bg).join(' | '));
      }

      assertions++;
      const cov = rows.flatMap((r) => r.m.covered.map((c) => ({ ...c, at: r.w.name })));
      if (cov.length) {
        failures++;
        console.log('    FAIL ' + entry.id + ' has content under fixed chrome  <- '
          + cov.slice(0, 3).map((c) => c.target + ' under .' + c.by).join(' | '));
      }

      assertions++;
      const tiny = rows.flatMap((r) => r.m.tiny.map((t) => ({ ...t, at: r.w.name })));
      if (tiny.length) {
        failures++;
        console.log('    FAIL ' + entry.id + ' renders text below the smallest token  <- '
          + tiny.slice(0, 3).map((t) => t.label + ' ' + t.fs + 'px @' + t.at).join(' | '));
      }
    }
  } finally {
    await b.close();
  }

  if (dumpAt) return;
  console.log('    measured ' + (dumpAt ? 0 : manifest.length) + ' surfaces at '
    + WIDTHS.length + ' widths'
    + (advisoryTotal ? ' (' + advisoryTotal + ' advisory)' : ''));
  console.log(failures
    ? '\n  layout check FAILED - ' + failures + ' of ' + assertions + ' groups failed'
    : '\n  layout check passed - ' + assertions + ' assertions');
  process.exit(failures ? 1 : 0);
}

main();
