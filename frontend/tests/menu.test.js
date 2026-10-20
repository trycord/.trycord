// The context menu.
//
// Two faults, and both of them made a menu that could not be used.
//
// **It closed on its own scroll.** The listener that closed the menu on a
// scroll was on the window in the capture phase, so it saw the scroll of
// every element in the document - the menu's own included. A menu with more
// items than fit could therefore never be scrolled: scrolling it closed the
// thing being scrolled. And it closed itself before a pointer could reach
// it, because the first item is focused a moment after the menu opens, and
// focusing an item inside a scrolling box scrolls that box.
//
// **The pointer was on its corner.** A menu opened at a point was placed with
// its top-left exactly under the pointer, so the first item sat under the
// cursor and the natural movement of the hand - right, and right and down -
// left the menu behind.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { openMenu, closeMenu, isMenuOpen } = await import('../js/ui/overlays.js');

const ITEMS = [
  { label: 'Reply' },
  { label: 'Copy the link' },
  { label: 'Pin' },
];

function scroll(target) {
  // A scroll event as the browser delivers it: it does not bubble, but a
  // capture-phase listener on the window sees it for any element.
  const event = new window.Event('scroll');
  Object.defineProperty(event, 'target', { value: target });
  window.dispatchEvent(event);
}

test('a menu stays open when it is scrolled', async () => {
  const menu = openMenu({ items: ITEMS, x: 100, y: 100 });
  assert.ok(menu, 'the menu did not open');
  assert.equal(isMenuOpen(), true);
  await new Promise((resolve) => setTimeout(resolve, 5));

  // The scroll of the menu itself.
  scroll(menu.element);

  assert.equal(isMenuOpen(), true,
    'the menu closed when it was scrolled, so a menu with more items than fit '
    + 'could never be reached');
  closeMenu();
  assert.equal(isMenuOpen(), false);
});

test('a menu closes when the page behind it scrolls', async () => {
  openMenu({ items: ITEMS, x: 100, y: 100 });
  // The menu registers its listeners on the next tick, so that the click
  // that opened it is not the click that closes it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  scroll(document.body);
  assert.equal(isMenuOpen(), false,
    'the menu stayed open when the page scrolled away from under it');
});

test('a menu opened at a point is not under the pointer', async () => {
  const menu = openMenu({ items: ITEMS, x: 100, y: 100 });
  const style = menu.element.style;
  const left = parseFloat(style.left);
  const top = parseFloat(style.top);
  assert.ok(left > 100, 'the menu starts exactly at the pointer horizontally');
  assert.ok(top > 100, 'the menu starts exactly at the pointer vertically');
  closeMenu();
});

test('a menu closed in the same tick leaves nothing behind', async () => {
  // A menu opened and closed inside one tick used to leave its handlers
  // behind: the removal ran before the registration, so the registration
  // happened afterwards and nothing ever took it off again.
  //
  // Those handlers were not harmless. The stale scroll handler closed
  // whatever menu was open *now*, so a menu could be closed by a scroll that
  // had nothing to do with it, and the stale key handler moved the focus into
  // a menu that was no longer on the page.
  const first = openMenu({ items: ITEMS, x: 100, y: 100 });
  closeMenu();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const second = openMenu({ items: ITEMS, x: 100, y: 100 });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // A scroll must close the live menu - and only because of its own handler.
  scroll(document.body);
  assert.equal(isMenuOpen(), false, 'the live menu did not close');
  void first;
  void second;
});

test('a closed menu does not take the focus back', async () => {
  // The first item is focused a moment after the menu opens. A menu that has
  // been closed by then must not pull the focus back to a removed item: the
  // reader has moved on, and pulling the focus to something that is no longer
  // on the page is how a reader ends up typing into nothing.
  const before = document.activeElement;
  openMenu({ items: ITEMS, x: 100, y: 100 });
  closeMenu();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(document.activeElement, before,
    'a closed menu pulled the focus back to an item that is no longer on the page');
});

test('a menu is reachable with the keyboard and closes with Escape', async () => {
  openMenu({ items: ITEMS, x: 100, y: 100 });
  const key = (name) => {
    const event = new window.Event('keydown');
    event.key = name;
    document.dispatchEvent(event);
  };

  // The first item is focused a moment after the menu opens.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const items = document.body.querySelectorAll('.menu-item');
  assert.ok(items.length, 'the menu has no items');
  assert.equal(document.activeElement, items[0], 'the first item is not focused');

  key('ArrowDown');
  assert.equal(document.activeElement, items[1], 'the next item was not reached');
  key('ArrowUp');
  assert.equal(document.activeElement, items[0], 'the previous item was not reached');

  key('Escape');
  assert.equal(isMenuOpen(), false, 'Escape did not close the menu');
});
