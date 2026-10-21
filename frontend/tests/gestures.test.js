// The swipe that replies to a message.
//
// A swipe is a gesture, and a gesture that fights the ordinary use of a
// message list is worse than no gesture at all. So the rules are checked:
// a vertical move is a scroll and nothing else; a drag on a control belongs
// to the control; the movement has to be long and mostly sideways before it
// means anything; and the message moves under the finger, so the reader can
// see it and let go.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { swipeToReply } = await import('../packages/gestures.js');

// A stand-in for a message row: enough of the DOM for the gesture to work on.
function row() {
  const node = document.createElement('div');
  node.className = 'msg';
  return node;
}

// An event of the kind a finger makes.
function at(x, y, target) {
  return { touches: [{ clientX: x, clientY: y }], target, cancelable: true };
}

function start(node, x, y) {
  node.dispatch('touchstart', at(x, y, node));
}
function move(node, x, y) {
  node.dispatch('touchmove', at(x, y, node));
}
function end(node) {
  node.dispatch('touchend', { touches: [], target: node, cancelable: true });
}

test('the swipe that replies to a message', async (t) => {
  await t.test('a long sideways drag replies', () => {
    const node = row();
    let replied = false;
    swipeToReply(node, () => { replied = true; });

    start(node, 10, 100);
    move(node, 110, 104);
    end(node);

    assert.equal(replied, true, 'the swipe did not reply');
  });

  await t.test('a short drag does not reply', () => {
    const node = row();
    let replied = false;
    swipeToReply(node, () => { replied = true; });

    start(node, 10, 100);
    move(node, 40, 102);
    end(node);

    assert.equal(replied, false, 'a short drag replied');
  });

  await t.test('a vertical move is a scroll and nothing else', () => {
    const node = row();
    let replied = false;
    swipeToReply(node, () => { replied = true; });

    start(node, 100, 100);
    // The finger goes down the list, and a little to the side.
    move(node, 130, 200);
    end(node);

    assert.equal(replied, false, 'a scroll replied');
  });

  await t.test('a drag on a control belongs to the control', () => {
    const node = row();
    const link = document.createElement('a');
    link.href = '#';
    node.appendChild(link);
    let replied = false;
    swipeToReply(node, () => { replied = true; });

    link.dispatch('touchstart', at(10, 100, link));
    link.dispatch('touchmove', at(120, 100, link));
    link.dispatch('touchend', { touches: [], target: link, cancelable: true });

    assert.equal(replied, false, 'a drag on a link replied');
  });

  await t.test('the message moves under the finger', () => {
    const node = row();
    swipeToReply(node, () => {});

    start(node, 10, 100);
    move(node, 60, 100);

    assert.ok(node.style.transform.indexOf('translateX') === 0,
      'the message did not move: ' + node.style.transform);
    assert.equal(node.classList.contains('is-swiping'), true,
      'the message does not say that it is being swiped');

    end(node);
    assert.ok(!node.style.transform, 'the message did not go back: ' + node.style.transform);
    assert.equal(node.classList.contains('is-swiping'), false,
      'the message still says it is being swiped');
  });
});
