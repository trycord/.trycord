// The community onboarding, on the desk and on the phone.
//
// Two screens: the administrator's, where the welcome, the rules and the
// questions are written, and the member's, where the questions are answered.
//
// The things worth checking are the ones a reader would notice:
//
//   - the administrator's screen says what answering a question does, because
//     they are the one writing the question;
//   - the member's screen says the same thing, before they answer;
//   - a required question is marked as one;
//   - the answers may be changed later.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';

installDomStub();

const { onboardingSection } = await import('../../js/features/communitySettings/onboarding.js');
const { onboardingView } = await import('../../js/features/onboarding.js');
const { State } = await import('../../packages/store.js');

State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];
State.user = { id: 'u1', username: 'operator' };

const CONFIGURATION = {
  onboarding: {
    enabled: true,
    welcomeTitle: 'Welcome',
    welcomeBody: 'Tell us what you are here for.',
    rules: [{ id: 'r1', text: 'Be kind.' }, { id: 'r2', text: 'No spam.' }],
    defaultChannels: [],
    required: true,
    questions: [
      {
        id: 'q1',
        position: 0,
        text: 'What brings you here?',
        kind: 'single',
        required: true,
        options: [
          { id: 'o1', label: 'To chat', roleIds: ['r-regular'], channelIds: [] },
          { id: 'o2', label: 'To build things', roleIds: [], channelIds: ['c1'] },
        ],
      },
      {
        id: 'q2',
        position: 1,
        text: 'Which do you want to see?',
        kind: 'multiple',
        required: false,
        options: [{ id: 'o3', label: 'The announcements', roleIds: [], channelIds: [] }],
      },
    ],
  },
  eligibleRoles: [{ id: 'r-regular', name: 'Regular', color: null }],
};

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byText(node, text) {
  const found = find(node, (candidate) => (candidate.textContent || '').indexOf(text) !== -1);
  let deepest = found[0] || null;
  for (const candidate of found) {
    if (!deepest) { deepest = candidate; continue; }
    if ((candidate.textContent || '').length < (deepest.textContent || '').length) deepest = candidate;
  }
  return deepest;
}

test('the administrator writes the onboarding', async () => {
  installFetchStub({
    'http://localhost/api/servers/s1/onboarding': { json: CONFIGURATION },
  });

  const view = onboardingSection({ serverId: 's1' });
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The title and the rules are written in fields, so they are read from the
  // fields and not from the text of the page.
  const inputs = find(view.node, (node) => node.tagName === 'INPUT'
    || node.tagName === 'TEXTAREA');
  const values = inputs.map((node) => node.value);
  assert.ok(values.indexOf('Welcome') !== -1, 'the welcome title is not shown');
  assert.ok(values.some((value) => String(value).indexOf('Be kind.') !== -1),
    'the rules are not shown');

  const text = view.node.textContent || '';
  assert.match(text, /What brings you here\?/, 'the questions are not shown');
  assert.match(text, /They have to answer it\./, 'a required question is not marked');
  assert.match(text, /They may skip it\./, 'an optional question is not marked');
  assert.match(text, /Gives: Regular/, 'the screen does not say what answering gives');
  assert.match(text, /Reveals 1 channel/, 'the screen does not say what answering reveals');
  assert.match(text, /These are the roles an answer may give/, 'the eligible roles are not named');
});

test('the member answers the questions', async () => {
  const preview = {
    onboarding: {
      enabled: true,
      welcomeTitle: 'Welcome',
      welcomeBody: 'Tell us what you are here for.',
      rules: [{ id: 'r1', text: 'Be kind.' }],
      defaultChannels: [],
      required: true,
      questions: [
        {
          id: 'q1',
          position: 0,
          text: 'What brings you here?',
          kind: 'single',
          required: true,
          answered: false,
          options: [
            { id: 'o1', label: 'To chat', grantsRoles: 1, revealsChannels: 0 },
            { id: 'o2', label: 'To build things', grantsRoles: 0, revealsChannels: 2 },
          ],
        },
      ],
      outstanding: 1,
    },
  };
  installFetchStub({
    'http://localhost/api/servers/s1/onboarding/preview': { json: preview },
    'http://localhost/api/servers/s1/onboarding/me': { json: { answers: [] } },
  });

  const view = onboardingView({ serverId: 's1' });
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const text = view.node.textContent || '';
  assert.match(text, /Welcome/, 'the welcome is not shown');
  assert.match(text, /Be kind\./, 'the rules are not shown');
  assert.match(text, /What brings you here\?/, 'the question is not shown');
  assert.match(text, /gives you 1 role\./, 'the member is not told what answering gives');
  assert.match(text, /shows you 2 channels\./, 'the member is not told what answering reveals');
  assert.match(text, /You have to answer this one/, 'the required question is not marked');
  assert.match(text, /There is still something to answer/, 'the outstanding question is not said');
});

test('a community with no onboarding says so', async () => {
  installFetchStub({
    'http://localhost/api/servers/s1/onboarding/preview': {
      json: { onboarding: { enabled: false, questions: [], rules: [] } },
    },
    'http://localhost/api/servers/s1/onboarding/me': { json: { answers: [] } },
  });

  const view = onboardingView({ serverId: 's1' });
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.match(view.node.textContent || '', /no welcome here/i,
    'the member is not told that there is no onboarding');
});
