// A conversation of more than two people.
//
// The list of conversations and the conversation itself have to agree about
// what a group is called, and a group must not be shown as though it were a
// conversation with one person in it - naming one of five members as "the
// person you are talking to" is a lie about the other four.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { State, dmName, dmPeer, dmPeople } = await import('../packages/store.js');

const GROUP = {
  id: 'g1',
  name: 'The work',
  isGroup: true,
  memberCount: 3,
  peer: null,
  people: [
    { id: 'u1', username: 'ada', displayName: 'Ada' },
    { id: 'u2', username: 'grace', displayName: 'Grace' },
    { id: 'u3', username: 'alan', displayName: 'Alan' },
  ],
};

test('a conversation of more than two people', async (t) => {
  await t.test('a group is called by its name', () => {
    State.user = { id: 'u1', username: 'ada', displayName: 'Ada' };
    assert.equal(dmName(GROUP), 'The work');
  });

  await t.test('a group has no single person on the other side', () => {
    // Naming one of them as "the peer" would be a lie about the other two.
    assert.equal(dmPeer(GROUP), null);
  });

  await t.test('the people in a group are the ones who are not the reader', () => {
    const people = dmPeople(GROUP);
    assert.equal(people.length, 2);
    assert.deepEqual(people.map((person) => person.username), ['grace', 'alan']);
  });

  await t.test('a group with no name is called by the people in it', () => {
    // A name that nobody chose is worse than the truth, and the people in it
    // are the only thing that says which conversation it is.
    assert.equal(dmName(Object.assign({}, GROUP, { name: null })), 'Grace and Alan');
    // The reader is not one of the people it is called by: a group with
    // nobody else in it has nobody to be called by.
    assert.equal(dmName(Object.assign({}, GROUP, {
      name: null, people: [GROUP.people[0], GROUP.people[1]],
    })), 'Grace');
    assert.equal(dmName(Object.assign({}, GROUP, { name: null, people: [GROUP.people[0]] })), 'A group');
    assert.equal(dmName(Object.assign({}, GROUP, {
      name: null,
      people: [GROUP.people[0], GROUP.people[1], GROUP.people[2],
        { id: 'u4', username: 'edsger', displayName: 'Edsger' }],
    })), 'Grace and 2 others');
  });

  await t.test('a conversation of two people is called by the other person', () => {
    const one = { id: 'c1', peer: { id: 'u2', username: 'grace', displayName: 'Grace' } };
    assert.equal(dmName(one), 'Grace');
    assert.equal(dmPeer(one).username, 'grace');
  });
});
