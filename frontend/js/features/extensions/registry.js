// The registry, and the consent that installs from it.
//
// An extension is a package with a manifest, a set of capabilities it asks for,
// a compatibility declaration, a review status and a signature. Installing one
// is a grant: the server refuses an install that does not say which
// capabilities it is being given, so this screen shows the request and takes
// the answer before it sends anything.
//
// The answer is a list. What is ticked is granted; what is not ticked stays
// with the package, and the package cannot use it. Nothing is granted by
// default, because a capability that is granted by default is a capability
// nobody agreed to.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, facts, hold, memo } from '../../ui/page.js';
import { openDialog, toast } from '../../ui/overlays.js';
import { readPackage, readRegistry, installExtension } from './api.js';
import { capabilityLabel, isOperator, reviewChip, signatureChip } from './parts.js';

// What the package says about itself, in the words it used.
function manifestFacts(pkg) {
  const factsLine = facts([
    { value: pkg.version || '—', label: 'Version' },
    { value: pkg.author || '—', label: 'Author' },
    { value: pkg.trusted ? 'yes' : 'no', label: 'Runs code here' },
  ]);
  const lines = [factsLine];
  if (pkg.entryPoint) {
    lines.push(el('p', { class: 'form-note' }, 'Entry point: ', el('span', { class: 'keyblock' }, pkg.entryPoint)));
  }
  if (pkg.homepage) {
    lines.push(el('p', { class: 'form-note' }, 'Home page: ', pkg.homepage));
  }
  if (pkg.maintainers && pkg.maintainers.length) {
    lines.push(el('p', { class: 'form-note' }, 'Maintained by: ' + pkg.maintainers.join(', ')));
  }
  return el('div', { class: 'fold fold--tight' }, lines);
}

// What the package declares about the instance it will run on.
function compatibilityFacts(pkg) {
  const compatibility = pkg.compatibility && typeof pkg.compatibility === 'object' ? pkg.compatibility : {};
  const entries = Object.keys(compatibility);
  if (!entries.length) return null;
  return el('div', { class: 'fold fold--tight' },
    el('p', { class: 'form-note' }, 'It declares it works with:'),
    el('div', { class: 'chips' }, entries.map((key) => el('span', { class: 'chip chip--quiet' },
      key + ' ' + compatibility[key]))));
}

// What the package needs to have installed already.
function dependencyFacts(pkg) {
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const entries = Object.keys(dependencies);
  if (!entries.length) return null;
  return el('div', { class: 'fold fold--tight' },
    el('p', { class: 'form-note' }, 'It needs:'),
    el('div', { class: 'chips' }, entries.map((key) => el('span', { class: 'chip chip--quiet' },
      key + ' ' + dependencies[key]))));
}

// The consent: one line per capability the package asks for, and a box beside
// each one. The boxes start empty, because an answer nobody gave is not an
// answer.
function capabilityConsent(pkg) {
  const requested = Array.isArray(pkg.requestedCapabilities) ? pkg.requestedCapabilities : [];
  const boxes = new Map();
  const list = el('div', { class: 'fold fold--tight' });
  if (!requested.length) {
    list.appendChild(el('p', { class: 'form-note' },
      'This package asks for no capabilities. It will do nothing it was not already able to do.'));
    return { list, boxes, requested };
  }
  list.appendChild(el('p', { class: 'form-note' },
    'Tick the capabilities this extension may use. It cannot use one you leave unticked, '
    + 'and you can take one back later.'));
  for (const capability of requested) {
    const box = el('input', {
      type: 'checkbox',
      value: capability,
      'aria-label': 'Grant ' + capabilityLabel(capability) + ' to ' + pkg.id,
    });
    boxes.set(capability, box);
    list.appendChild(el('label', { class: 'checkbox' },
      box,
      el('span', {},
        el('span', {}, capabilityLabel(capability)),
        el('span', { class: 'form-note' }, ' ' + capability))));
  }
  return { list, boxes, requested };
}

// The consent screen. It reads the package first, shows what the package asks
// for, and sends the install only once the operator has answered.
export function openConsent(packageId, options) {
  const opts = options || {};
  const body = el('div', { class: 'fold' });
  const status = el('p', { class: 'form-error', role: 'status' });
  const install = el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: true }, 'Install');
  const dialog = openDialog({
    title: 'Install ' + packageId,
    sub: 'An extension is installed with the capabilities you grant it, and with nothing else.',
    body: el('div', { class: 'fold' }, body, status),
    foot: [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      install,
    ],
  });

  const granted = () => [...consent.boxes.entries()]
    .filter((entry) => entry[1].checked)
    .map((entry) => entry[0]);

  let consent = { boxes: new Map(), requested: [] };
  let pkg = null;

  function refreshButton() {
    // An install is only sent with an answer. A package that asks for
    // capabilities cannot be installed with none of them granted, because that
    // is never what the operator meant.
    install.disabled = !pkg || (consent.requested.length > 0 && granted().length === 0);
    install.textContent = consent.requested.length
      ? 'Install with ' + granted().length + ' capabilit' + (granted().length === 1 ? 'y' : 'ies')
      : 'Install';
  }

  async function load() {
    body.replaceChildren(hold('Reading the package'));
    try {
      const answer = await readPackage(packageId);
      pkg = (answer && answer.package) || {};
      consent = capabilityConsent(pkg);
      body.replaceChildren(
        el('div', { class: 'fold fold--tight' },
          el('p', { class: 'lede' }, pkg.description || 'The package gave no description.'),
          el('div', { class: 'chips' }, reviewChip(pkg.reviewStatus), signatureChip(pkg.signature),
            pkg.trusted ? el('span', { class: 'chip chip--warn' }, 'runs code on the server') : null),
          manifestFacts(pkg),
          compatibilityFacts(pkg),
          dependencyFacts(pkg)),
        consent.list);
      for (const box of consent.boxes.values()) box.addEventListener('change', refreshButton);
      if (pkg.installable === false && pkg.reason) {
        status.textContent = pkg.reason;
        install.disabled = true;
      } else {
        status.textContent = '';
      }
      refreshButton();
    } catch (error) {
      body.replaceChildren(fault(error, load));
    }
  }

  install.addEventListener('click', async () => {
    install.disabled = true;
    status.textContent = '';
    try {
      // The grant list is always sent. It is the consent, and an install
      // without one is refused by the server.
      const answer = await installExtension({
        id: pkg.id,
        version: pkg.version || null,
        grants: granted(),
      });
      const given = (answer && answer.granted) || [];
      const refused = (answer && answer.refused) || [];
      const note = [];
      if (given.length) note.push('granted: ' + given.join(', '));
      if (refused.length) note.push('not granted: ' + refused.map((entry) => entry.capability).join(', '));
      toast('Installed.' + (note.length ? ' ' + note.join('. ') + '.' : ''));
      dialog.close();
      if (opts.onInstalled) opts.onInstalled(answer);
    } catch (error) {
      status.textContent = (error && error.message) || 'The install was refused.';
      install.disabled = false;
    }
  });

  load();
  return dialog;
}

// The registry as this instance sees it.
export function registrySection() {
  const list = el('div', { class: 'rowlist' });
  const note = el('div', { class: 'fold' });
  const refresh = el('button', {
    class: 'btn btn--default btn--sm', type: 'button',
    onClick: () => paint({ refresh: true }),
  }, 'Read the registry again');

  function entryRow(entry) {
    const installable = entry.installable !== false;
    return row({
      lead: el('span', { class: 'role-dot' }, icon('rocket', { size: 15 })),
      title: entry.name || entry.id,
      sub: (entry.description || '') + (entry.author ? ' · ' + entry.author : ''),
      meta: el('span', { class: 'chips' },
        reviewChip(entry.reviewStatus),
        signatureChip(entry.signature),
        entry.trusted ? el('span', { class: 'chip chip--warn' }, 'runs code here') : null),
      side: el('div', { class: 'cardrow-side' },
        el('span', { class: 'cardrow-sub' }, 'asks for '
          + (entry.requestedCapabilities || []).length + ' capabilit'
          + ((entry.requestedCapabilities || []).length === 1 ? 'y' : 'ies')),
        isOperator() && installable
          ? el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            'aria-label': 'Install ' + (entry.name || entry.id),
            onClick: () => openConsent(entry.id, { onInstalled: () => paint() }),
          }, 'Install')
          : null,
        isOperator() && !installable
          ? el('span', { class: 'chip chip--quiet' }, 'not installable')
          : null),
    });
  }

  async function paint(options) {
    const opts = options || {};
    list.replaceChildren(hold('Reading the registry'));
    try {
      const answer = await readRegistry({ refresh: !!opts.refresh });
      const registry = (answer && answer.registry) || {};
      const entries = Array.isArray(registry.extensions) ? registry.extensions : [];
      note.replaceChildren();
      if (registry.error) {
        note.appendChild(memo({
          tone: 'warning',
          title: registry.stale ? 'The registry could not be reached' : 'The registry reported a problem',
          text: registry.error + (registry.stale ? ' The list below is the last copy this instance saw.' : ''),
        }));
      } else if (!registry.available) {
        note.appendChild(memo({
          tone: 'info',
          title: 'The registry is switched off',
          text: 'This instance does not offer extensions to install.',
        }));
      } else {
        note.appendChild(el('p', { class: 'form-note' },
          'The registry is read from the ' + (registry.source || 'configured') + ' source.'));
      }
      list.replaceChildren(...(entries.length
        ? entries.map(entryRow)
        : [blank({
          glyph: 'rocket',
          title: 'The registry offers nothing',
          text: 'No package is on offer here. A mirror may be out of reach, or the directory may be empty.',
        })]));
    } catch (error) {
      list.replaceChildren(fault(error, () => paint()));
    }
  }

  return {
    node: fold([
      card({
        label: 'What is on offer',
        glyph: 'rocket',
        note: 'what this instance could install',
        actions: refresh,
        body: el('div', { class: 'fold' }, note, list),
      }),
    ]),
    onMount: () => paint(),
    cleanup() {},
  };
}

export default { registrySection, openConsent };
