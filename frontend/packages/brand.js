// The brand monogram, and where it lives.
//
// The canonical file is in the shared asset library at the client root:
// assets/trycord-assets/brand/trycord-symbol.svg. Every surface that showed it
// used to spell that path out for itself, and each spelled it from where it
// stood: `assets/...` from the Desktop entry, `../assets/...` from the Mobile
// one, because the two entries sit at different depths of the same tree. Two
// spellings of one file is how a monogram gets requested from a directory that
// does not exist, and - the failure that started this module - how an image
// nobody sized falls back to the 512px its SVG carries, which on a phone is a
// logo that fills the app bar and half the screen behind it.
//
// So the address is derived once, here, from this file's own URL. packages/ sits
// one directory under the client root in both frontends, so its parent is the
// root whether the client is mounted at /app, served from an origin root, or
// opened off disk. That is the same reasoning packages/nav.js uses to find the
// mount, for the same reason: the answer follows the file rather than a
// hard-coded /app that only one deployment has.
//
// What stays out of this module is the markup around the monogram. The two
// frontends wrap it differently - an app-bar link, a spine mark, a sign-in
// lockup - and each wrapper is that frontend's own control, not a shared one.
// This exports the address and a sized image; the class on the link and where it
// is put stay with the module that draws them, because a class name written here
// would be checked against the wrong stylesheet (packages is read as Desktop).

import { el } from './dom.js';

const CLIENT_ROOT = new URL('..', import.meta.url);

// One address, derived from this file's location rather than spelled per entry.
// The library sits under `assets/` at the client root, which is why the path
// carries that segment: the root is the directory the entries are served from,
// not the asset directory itself.
export const brandSymbolUrl = new URL('assets/trycord-assets/brand/trycord-symbol.svg', CLIENT_ROOT).href;

// The monogram, at a box size this call names.
//
// The size travels with the markup because the symbol ships with width and
// height attributes of 512 of its own, and the CSS that draws these marks sizes
// them by percentage against the box they are in. Percentage against a box
// nothing sized is how the intrinsic size wins; naming the box here and in the
// stylesheet is what keeps the mark a mark.
export function brandMark(options) {
  const opts = options || {};
  const size = opts.size || 28;
  return el('img', {
    class: opts.className || undefined,
    src: brandSymbolUrl,
    // Always an attribute, even when empty: a monogram is decorative beside the
    // link's own label, and an <img> with no alt is announced as an unlabeled
    // image by every reader.
    alt: opts.alt || '',
    width: size,
    height: size,
    loading: opts.loading || undefined,
  });
}
