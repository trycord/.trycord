// Builds the shell's DOM once, when the application starts.
//
// The tree it draws is the one the rest of the application addresses by id, and
// it is declared here so there is one place that says what the regions are. What
// fills them belongs elsewhere: the rail to shell/rail.js, the channel list to
// shell/navigation.js, the header to shell/context-header.js, all driven by
// renderAllChrome(). This file rendering them too was a second implementation of
// the same rail, so it no longer does.
//
// The one piece of behaviour here is the keyboard shortcut, and only the search
// one is new: the drawer toggle already existed in presentation.js, which owns
// the focus return and the backdrop.

import { Component } from './components/base.js';
import { el } from './ui/dom.js';
import { toggleNav } from './presentation.js';

export class AppShell extends Component {
  constructor(props = {}) {
    super();
    this.props = { ...props };
  }

  render() {
    // The tree this shell draws is the one the rest of the application already
    // addresses by id: the same regions, the same contracts, the same overlays.
    return el('section', { id: 'shell', class: 'shell', 'aria-label': 'Trycord' }, [
      // The rail's four regions are left empty here and filled by
      // renderAllChrome() through shell/rail.js, which is the one place that
      // knows what the navigation contains.
      el('aside', { id: 'app-rail', class: 'app-rail', 'aria-label': 'Navigation' }, [
        el('header', { id: 'identity-region', class: 'rail-identity' }),
        el('nav', { id: 'global-navigation', class: 'rail-global-nav', 'aria-label': 'Global navigation' }),
        el('section', { id: 'community-navigation', class: 'app-rail__items', 'aria-label': 'Communities' }),
        el('footer', { id: 'rail-foot', class: 'rail-foot', 'aria-label': 'Account' }),
      ]),

      el('section', {
        id: 'place-navigation',
        class: 'context-sidebar',
        'aria-label': 'Current place navigation',
      }),

      el('main', { id: 'trycord-main', class: 'main-content' }, [
        el('header', { id: 'context-header', class: 'context-header' }),
        el('div', { class: 'chat-environment' }, [
          el('section', { id: 'view-root', class: 'view-root' }),
          el('aside', {
            id: 'member-sidebar',
            class: 'member-sidebar',
            'aria-label': 'Community members',
          }),
        ]),
      ]),

      el('div', { id: 'desktop-backdrop', class: 'nav-backdrop', 'aria-hidden': 'true', hidden: true }),
      el('nav', { id: 'mobile-tab-navigation', class: 'mobile-tab-navigation', 'aria-label': 'Primary navigation' }),
      el('div', { id: 'modal-root', class: 'modal-root' }),
      el('div', { id: 'popover-root', class: 'popover-root' }),
      el('div', { id: 'route-announcer', class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }),
      el('div', { id: 'toast-root', class: 'toast-root', 'aria-live': 'polite', 'aria-atomic': 'true' }),
      el('div', { id: 'connection-status', class: 'connection-status', role: 'status', 'aria-live': 'polite' }),
    ]);
  }

  onMount() {
    this.bindKeyboardShortcuts();
  }

  onUnmount() {}

  bindKeyboardShortcuts() {
    this.on(document, 'keydown', (e) => {
      // The search shortcut and the drawer toggle, and nothing else. The drawer's
      // own logic is presentation.js's: it owns the focus return, the backdrop and
      // the aria-expressed state, and a second implementation here was two answers
      // to one question.
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === 'k') {
        e.preventDefault();
        this.props.onSearch?.();
        return;
      }
      if (mod && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        toggleNav();
      }
    });
  }
}

/** Build the shell tree into the #app mount point. */
export function buildShell(props = {}) {
  const host = document.getElementById('app');
  if (!host) return null;

  const shell = new AppShell(props);
  shell.mount(host);
  return shell;
}
