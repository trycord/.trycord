// The UI layer.
//
// One module that almost everything imports from, and which held four unrelated things:
// the primitives, the menu system, the things that talk to the reader, and text
// formatting. It is now the re-export surface it was already half-way to being, with
// dom.js and menus.js beside it and the twenty things it still owned split by what they
// are:
//
//   ui/dom.js       the primitives - el, clear, qs, icon
//   ui/menus.js     the menu system - attachMenu, showContextMenu
//   ui/feedback.js  toasts and the live region they announce into
//   ui/overlay.js   buttons, and the modal that covers the page
//   ui/dialogs.js   dialogs that ask a question and expect an answer
//   ui/usercard.js  the hover card, and copying text
//   ui/report.js    reporting content
//   ui/emoji.js     the emoji picker and its table
//   ui/text.js      relTime, plural, and the rest - not UI in the sense the rest of this
//                   directory means it
//
// Splitting by what a thing *is* rather than by size is the point. relTime and plural are
// the two most-called functions in the client, and while they sat beside the modal system
// both looked like part of it. Nothing here is large; it was just unrelated.
//
// Everything still imports from this module, so no import in the client changed.

import { TrycordConfig } from './config.js';

// Imported, then exported again, rather than exported directly. `export { x } from
// './y.js'` re-exports without creating a local binding, so anything below that uses
// esc, el, clear, icon, qs, focusQuietly or closeContextMenu - including this file's own
// default export - was reading a name that does not exist in this scope.
import {
  esc, ICON_PATHS, icon, el, clear, clearAndRebuild, qs, qsa, focusQuietly,
} from './ui/dom.js';
import {
  attachMenu, showContextMenu, attachContextMenu, closeContextMenu,
} from './ui/menus.js';

import { toast, announce } from './ui/feedback.js';
import { btn, openModal, openLightbox } from './ui/overlay.js';
import { passwordDialog, confirmDialog } from './ui/dialogs.js';
import { showUserCard, copyText } from './ui/usercard.js';
import { REPORT_CATEGORIES, openReportDialog } from './ui/report.js';
import { showEmojiPicker } from './ui/emoji.js';
import { insertAtCursor, plural, relTime, fullTime, apiSrc } from './ui/text.js';

// Re-exported so `import { el, attachMenu } from '../ui.js'` keeps working.
export {
  esc, ICON_PATHS, icon, el, clear, clearAndRebuild, qs, qsa, focusQuietly,
  attachMenu, showContextMenu, attachContextMenu, closeContextMenu,
  toast, announce,
  btn, openModal, openLightbox,
  passwordDialog, confirmDialog,
  showUserCard, copyText,
  REPORT_CATEGORIES, openReportDialog,
  showEmojiPicker,
  insertAtCursor, plural, relTime, fullTime, apiSrc,
};

// The same nine names as before, in the same order. Widening a default export because the
// module now knows about more things is a change nobody asked for.
export default { esc, el, clear, toast, openModal, confirmDialog, relTime, fullTime, apiSrc, announce };
