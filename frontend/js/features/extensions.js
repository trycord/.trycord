// The extension console.
//
// One page and four sections: what the registry offers, what this instance has
// installed, the policy that decides what may be installed at all, and the
// workflows that run here.
//
// The four are one surface rather than four pages because they are one job:
// deciding what may run on this instance, installing it, and watching it run.
// Splitting them across four addresses would put the policy a whole screen
// away from the thing it governs.
//
// Two of the sections are an administrator's business - the installed list and
// the policy - and the console does not offer them to anybody else. The
// registry may be looked at by anybody signed in, and a workflow may be run by
// the person who owns it.

import { el } from '../../packages/dom.js';
import { head, fold } from '../ui/page.js';
import { registrySection } from './extensions/registry.js';
import { installedSection } from './extensions/installed.js';
import { policySection } from './extensions/policy.js';
import { workflowsSection } from './extensions/workflows.js';
import { isOperator } from './extensions/parts.js';

const SECTIONS = [
  { id: 'registry', label: 'Registry', view: registrySection, operator: false },
  { id: 'installed', label: 'Installed', view: installedSection, operator: true },
  { id: 'policy', label: 'Policy', view: policySection, operator: true },
  { id: 'workflows', label: 'Workflows', view: workflowsSection, operator: false },
];

export function renderExtensions(ctx) {
  const tabs = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Extension console sections' });
  const stage = el('div', { class: 'fold fold--tight' });

  let current = null;
  let live = null;

  const offered = () => SECTIONS.filter((section) => !section.operator || isOperator());

  // The section may be named in the address, so that a particular one can be
  // linked to and a reader can come back to it.
  function wantedSection() {
    const asked = ctx && ctx.query ? String(ctx.query.get('section') || '') : '';
    return offered().some((section) => section.id === asked) ? asked : SECTIONS[0].id;
  }

  function paintTabs() {
    tabs.replaceChildren(...offered().map((section) => el('button', {
      class: 'segmented-item',
      type: 'button',
      'aria-selected': current === section.id ? 'true' : 'false',
      'aria-label': 'Show the ' + section.label.toLowerCase() + ' section',
      onClick: () => show(section.id),
    }, section.label)));
  }

  async function show(id) {
    const section = offered().find((entry) => entry.id === id) || offered()[0];
    if (!section) return;
    current = section.id;
    paintTabs();
    // The section that was open is put away before the next one is built, so
    // only one of them is ever reading the server.
    if (live && live.cleanup) live.cleanup();
    live = section.view();
    stage.replaceChildren(live.node);
    if (live.onMount) await live.onMount();
  }

  const node = fold([
    head({
      kicker: 'Instance',
      title: 'Extensions',
      lede: 'What may be installed here, what is installed, and what it is allowed to do.',
    }),
    tabs,
    stage,
  ]);

  return {
    node,
    onMount: () => show(wantedSection()),
    cleanup() {
      if (live && live.cleanup) live.cleanup();
      live = null;
    },
  };
}

export default { renderExtensions };
