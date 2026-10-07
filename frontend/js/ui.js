// The UI layer: everything imports from here.
//
// dom.js and menus.js hold the primitives. The rest - toasts, modals, dialogs, the user
// card, reports, emoji, text formatting - are in a module named for what they are.

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
