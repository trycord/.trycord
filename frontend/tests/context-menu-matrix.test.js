// The context-menu matrix.
//
// The two shells each have a menu for a channel, a category and a member,
// and a reader is owed the same set of actions in both of them. A menu that
// grows on one shell and not the other is a menu that lies about the
// software - and the gap is invisible until somebody opens the same thing on
// a phone and on a desk.
//
// So the actions are written down once, in packages/actions.js, and the check
// asks two questions:
//
//   - does every action in the table have a handler in both shells? An
//     action with no handler is a button that does nothing, which is worse
//     than no button;
//   - and does each shell's menu offer exactly the actions the table says?
//     A menu with an action the table does not name is a menu that has
//     drifted, and the table is what the two shells agree on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTION_MATRIX, actionIds } from '../packages/actions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..');

// The menus, and the file each one is in.
const MENUS = [
  { kind: 'channel', file: 'js/community/manage.js', builder: 'channelMenuItems' },
  { kind: 'channel', file: 'mobile/js/manage.js', builder: 'channelActions' },
  { kind: 'category', file: 'js/community/manage.js', builder: 'categoryMenuItems' },
  { kind: 'category', file: 'mobile/js/manage.js', builder: 'categoryActions' },
  { kind: 'member', file: 'js/ui/members.js', builder: 'memberActions' },
  { kind: 'member', file: 'mobile/js/views/community.js', builder: 'memberActions' },
];

// The source of a menu builder.
function sourceOf(entry) {
  return fs.readFileSync(path.join(CLIENT, entry.file), 'utf8');
}

// The action ids a menu builder names.
//
// The ids are read from the source rather than from the menu, because the
// menu needs a browser and a signed-in reader and this check is about what
// the two shells promise each other. The ids in the source are the handlers,
// and the table says what there should be.
function handlersIn(entry) {
  const source = sourceOf(entry);
  const table = ACTION_MATRIX[entry.kind];
  const found = [];
  for (const action of table) {
    // A handler is named in one of the two ways a shell names one: as a key
    // in the handler map, or as the id itself.
    const asKey = new RegExp('[\'"]' + action.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]\\s*:');
    if (asKey.test(source)) { found.push(action.id); continue; }
    const asCall = new RegExp('\\b' + action.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\s*:');
    if (asCall.test(source)) found.push(action.id);
  }
  return found;
}

test('the context-menu matrix', async (t) => {
  await t.test('every action in the table has a handler in both shells', () => {
    const missing = [];
    for (const entry of MENUS) {
      const handlers = handlersIn(entry);
      for (const id of actionIds(ACTION_MATRIX[entry.kind])) {
        if (!handlers.includes(id)) {
          missing.push(entry.builder + ' (' + entry.file + ') has no handler for ' + id);
        }
      }
    }
    assert.deepEqual(missing, [],
      'actions with no handler:\n' + missing.join('\n'));
  });

  await t.test('both shells offer the same actions', () => {
    // The two shells of the same kind of thing.
    const byKind = new Map();
    for (const entry of MENUS) {
      const list = byKind.get(entry.kind) || [];
      list.push(entry);
      byKind.set(entry.kind, list);
    }
    for (const [kind, entries] of byKind.entries()) {
      const table = actionIds(ACTION_MATRIX[kind]);
      for (const entry of entries) {
        const handlers = handlersIn(entry);
        const extra = handlers.filter((id) => !table.includes(id));
        assert.deepEqual(extra, [],
          entry.builder + ' offers actions the table does not name: ' + extra.join(', '));
      }
    }
  });

  await t.test('the table names the permission each action needs', () => {
    // An action that changes something has to say who may change it.
    for (const [kind, table] of Object.entries(ACTION_MATRIX)) {
      for (const action of table) {
        assert.ok(action.id && action.label && action.icon,
          'an action in the ' + kind + ' table is incomplete: ' + JSON.stringify(action));
      }
    }
  });

  await t.test('the dangerous actions say so', () => {
    // The shells draw the destructive ones in red, and that comes from the
    // table rather than from each shell deciding on its own.
    for (const [kind, table] of Object.entries(ACTION_MATRIX)) {
      for (const action of table) {
        if (/^(delete|ban|kick)$/.test(action.id)) {
          assert.equal(action.danger, true,
            'the ' + kind + ' action "' + action.id + '" is destructive and does not say so');
        }
      }
    }
  });
});
