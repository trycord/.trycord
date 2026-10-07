// The Privacy page's three tabs, and the hook that keeps them current.
//
//   privacy/privacy.js        who can reach you, and blocking
//   privacy/notifications.js per-channel muting and notification preferences
//   privacy/wellbeing.js     the things that reduce pressure rather than noise
//   privacy/sync.js           a realtime event means the stored preference changed
//
// They shared one file because they are three tabs of one page and shared a save helper.
// A change to wellbeing settings was a merge conflict with a change to who can message
// you, which is not a reason to keep them together.
//
// Every surface here reads from the API rather than a cached copy: a server-enforced
// preference shown from stale state disagrees with reality exactly when it matters.

import { renderPrivacySection, blockButton } from './privacy/privacy.js';
import { renderNotificationPrefsSection } from './privacy/notifications.js';
import {
  renderWellbeingSection, applyWellbeingToDocument, loadWellbeing,
} from './privacy/wellbeing.js';
import { watchForRemoteChanges } from './privacy/sync.js';

export {
  renderPrivacySection, blockButton,
  renderNotificationPrefsSection,
  renderWellbeingSection, applyWellbeingToDocument, loadWellbeing,
  watchForRemoteChanges,
};

export default {
  renderPrivacySection, blockButton,
  renderNotificationPrefsSection,
  renderWellbeingSection, applyWellbeingToDocument, loadWellbeing,
  watchForRemoteChanges,
};