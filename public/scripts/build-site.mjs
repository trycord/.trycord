#!/usr/bin/env node
'use strict';

// The shared furniture of the public site.
//
// Every page carries the same masthead and the same footer. They used to be
// copied into each page by hand, and they drifted: five of the twenty-eight
// pages had a different masthead, one of them had lost the Community group
// entirely, and two had links the others did not. A navigation that differs
// from page to page is a navigation nobody can rely on.
//
// So the masthead and the footer are written down once, here, and this script
// writes them into every page. The pages keep their own markup - the site is
// static, the links are read by crawlers and by readers without JavaScript -
// but they cannot drift, because the script is what puts them there.
//
//   node public/scripts/build-site.mjs          write the furniture into the pages
//   node public/scripts/build-site.mjs --check   fail if a page is out of date
//
// The check runs in the tests, so a page edited by hand without the script
// fails the build rather than shipping a different masthead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..');
const REPO = path.join(PUBLIC, '..');

const CHECK = process.argv.includes('--check');

// -- the masthead ---------------------------------------------------------------

const MARK = '<svg class="mark" viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">\n'
  + '          <path d="M50 9 L88 78 Q90 82 85 82 L65 82 L50 56 L35 82 L15 82 Q10 82 12 78 Z" fill="currentColor"/>\n'
  + '          <path d="M39 70 L50 51 L61 70 Z" fill="var(--cutout)"/>\n'
  + '          <path d="M49 31 L67 31 L67 40 L58 40 L58 49 L49 49 Z" fill="var(--cutout)"/>\n'
  + '          <circle cx="72" cy="58" r="7" fill="var(--cutout)"/>\n'
  + '        </svg>';

const CHEVRON = '<svg class="icon chevron" viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></g></svg>';

const SUN = '<svg class="icon icon-sun" viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>';

const MOON = '<svg class="icon icon-moon" viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></g></svg>';

const MENU = '<svg class="icon" viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></g></svg>';

// The groups of the masthead.
//
// Every entry is a page the site really has. The active one is marked by the
// reader's own script, so the list is written once and never carries a
// "current page" that goes stale.
function group(trigger, entries, wide) {
  const links = entries.map(([href, title, note]) => {
    // A link that leaves the site says so, and opens in a new tab.
    const external = /^https?:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener"' : '';
    return wide
      ? `              <a href="${href}"${attrs}><strong>${title}</strong><span>${note}</span></a>`
      : `            <a href="${href}"${attrs}><strong>${title}</strong><span>${note}</span></a>`;
  }).join('\n');
  const inner = wide
    ? `            <div class="nav-menu-grid">\n${links}\n            </div>`
    : links;
  return `        <div class="nav-group" data-nav-group>
          <button class="nav-trigger" type="button" data-nav-trigger aria-expanded="false" aria-haspopup="true">
            ${trigger}
            ${CHEVRON}
          </button>
          <div class="nav-menu${wide ? ' nav-menu--wide' : ''}">
${inner}
          </div>
        </div>`;
}

const HEADER = `<header class="site-header">
    <div class="wrap masthead">
      <a class="brand" href="/">
        ${MARK}
        <span class="brand-word">Trycord</span>
      </a>

      <button class="menu-toggle" type="button" data-menu-toggle aria-controls="site-nav" aria-expanded="false" aria-label="Open menu">
        ${MENU}
      </button>

      <nav class="site-nav" id="site-nav" aria-label="Primary">
${group('Product', [
  ['/features', 'Features', 'Channels, roles, moderation and more.'],
  ['/docs', 'Documentation', 'Run and configure your own instance.'],
  ['/developers', 'Developers', 'Build a bot with the API and the SDK.'],
  ['/download', 'Download', 'Get the desktop app for your computer.'],
  ['/changelog', 'Changelog', "What's new in Trycord."],
  ['/roadmap', 'Roadmap', "What's done and what's coming."],
  ['/status', 'Status', 'Live health for this instance.'],
], true)}

${group('Explore', [
  ['/communities', 'Communities', 'Browse public communities.'],
  ['/instances', 'Instances', 'Find an instance to join.'],
  ['/demo', 'Demo', 'Try Trycord without an account.'],
], false)}

${group('Community', [
  ['/support', 'Support', 'Get help and reach the project.'],
  ['https://discord.gg/dSF7eqsJuP', 'Discord', 'Join the community chat.'],
  ['/security', 'Security', 'How to report a vulnerability.'],
  ['/trust-and-safety', 'Trust and safety', 'Rules, reporting, and appeals.'],
], true)}

${group('About', [
  ['/about', 'About Trycord', "Why Trycord exists and how it's built."],
  ['/faq', 'FAQ', 'The questions people ask most.'],
  ['/install', 'Install', 'Run your own instance.'],
  ['/changelog', 'Changelog', "What's shipped recently."],
  ['/roadmap', 'Roadmap', 'Where the project is going.'],
], false)}
      </nav>

      <div class="masthead-actions">
        <button class="theme-toggle" type="button" data-theme-toggle hidden aria-pressed="false" aria-label="Switch between the light and dark theme">
          ${SUN}
          ${MOON}
        </button>
        <a class="btn btn-ghost btn-sm" href="/app/register" data-app-link>Create account</a>
        <a class="btn btn-primary btn-sm" href="/app/" data-app-link>Open the app</a>
      </div>
    </div>
  </header>`;

// -- the footer -----------------------------------------------------------------

const FOOTER = `<footer class="site-footer">
    <div class="wrap footer-grid">
      <div class="footer-col footer-brand">
        <a class="brand" href="/">
          ${MARK}
          <span class="brand-word">Trycord</span>
        </a>
        <p>Private, self-hostable community messaging. One client, browser and desktop.</p>
        <a class="btn btn-primary btn-sm" href="/app/register" data-app-link>Create account</a>
      </div>
      <div class="footer-col">
        <h2 class="footer-heading">Product</h2>
        <a href="/features">Features</a>
        <a href="/download">Desktop app</a>
        <a href="/demo">Demo</a>
        <a href="/changelog">Changelog</a>
        <a href="/roadmap">Roadmap</a>
        <a href="/status">Status</a>
      </div>
      <div class="footer-col">
        <h2 class="footer-heading">Documentation</h2>
        <a href="/docs">Self-hosting guide</a>
        <a href="/install">Install</a>
        <a href="/faq">FAQ</a>
        <a href="/support">Support</a>
        <a href="/security">Security</a>
      </div>
      <div class="footer-col">
        <h2 class="footer-heading">Developers</h2>
        <a href="/developers">Developer guide</a>
        <a href="/developers#the-api-reference">API reference</a>
        <a href="/developers#the-sdk-trycord-botjs">SDK</a>
      </div>
      <div class="footer-col">
        <h2 class="footer-heading">Open source</h2>
        <a href="https://github.com/trycord/.trycord" rel="noopener">Source code</a>
        <a href="/licenses">Licences</a>
        <a href="/about">About the project</a>
        <a href="/trust-and-safety">Trust and safety</a>
      </div>
      <div class="footer-col">
        <h2 class="footer-heading">Legal</h2>
        <a href="/terms">Terms of service</a>
        <a href="/privacy">Privacy</a>
        <a href="/cookies">Cookies</a>
        <a href="/instances-terms">Instance terms</a>
        <a href="/community-guidelines">Community rules</a>
      </div>
    </div>
    <div class="wrap footer-bottom">
      <span>&copy; <span data-year>2026</span> Trycord</span>
      <span class="muted">Your instance, your conversations, your rules.</span>
    </div>
  </footer>`;

// -- the writing ----------------------------------------------------------------

function replaceRegion(text, start, end, replacement) {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const to = text.indexOf(end, from);
  if (to === -1) return null;
  return text.slice(0, from) + replacement + text.slice(to + end.length);
}

const pages = fs.readdirSync(PUBLIC).filter((name) => name.endsWith('.html')).sort();
const stale = [];
let written = 0;

for (const name of pages) {
  const file = path.join(PUBLIC, name);
  const source = fs.readFileSync(file, 'utf8');
  let next = replaceRegion(source, '<header class="site-header">', '</header>', HEADER);
  next = replaceRegion(next, '<footer class="site-footer">', '</footer>', FOOTER);
  if (next === null || next === source) {
    if (next !== source) continue;
    // Nothing changed: the page already carries the shared furniture.
    continue;
  }
  if (next === source) continue;
  written++;
  if (CHECK) {
    stale.push(name);
    continue;
  }
  fs.writeFileSync(file, next);
}

if (CHECK) {
  if (stale.length) {
    console.log('these pages do not carry the shared masthead and footer:\n');
    for (const name of stale) console.log('  ' + name);
    console.log('\nrun: node public/scripts/build-site.mjs');
    process.exit(1);
  }
  console.log('every page carries the shared masthead and footer: ' + pages.length + ' pages');
} else {
  console.log('the shared masthead and footer are in ' + written + ' page(s) of ' + pages.length);
}
