import Api from './api.js';
import State from './state.js';
import Realtime from './realtime.js';

import {
  currentServerId, enterServer, reloadServer, isAuthed, leaveServerContext, refreshServerView,
} from './state.js';
import { showEmojiPicker, toast } from './ui.js';
import { onStale } from './view-states.js';
import { renderAllChrome, currentRoute } from './shell.js';
import { navigate } from './nav.js';

// stays private here and is reached through these two accessors.
let activeChannelId = null;

export function setActiveChannel(channelId) {
  activeChannelId = channelId === undefined ? null : channelId;
}

export function currentActiveChannel() {
  return activeChannelId;
}

function pickReaction(messageId) {
  showEmojiPicker(document.body, async (emoji) => {
    try { await Api.addReaction(activeChannelId, messageId, emoji); }
    catch (ex) { toast(ex.message || 'Could not react.', 'error'); }
  });
}

const COMMUNITY_EVENTS = [
  'member_joined', 'member_left', 'member_kicked', 'member_banned',
  'member_unbanned', 'member_timeout', 'member_updated', 'member_roles_updated',
  'role_created', 'role_updated', 'role_deleted', 'roles_reordered',
  'channel_created', 'channel_updated', 'channel_deleted', 'channels_reordered',
  'category_created', 'category_updated', 'category_deleted', 'categories_reordered',
  'invite_created', 'invite_revoked', 'server_updated',
];
const SELF_REMOVAL = new Set(['member_left', 'member_kicked', 'member_banned']);
let communityWired = false;

function wireCommunityEvents() {
  if (communityWired) return;
  communityWired = true;
  for (const type of COMMUNITY_EVENTS) {
    Realtime.on(type, async (payload) => {
      try {
        const sid = currentServerId();
        if (!sid || !isAuthed()) return;
        const me = State.me && State.me.id;
        if (me && payload && SELF_REMOVAL.has(type) && String(payload.userId) === String(me)) {
          leaveServerContext();
          renderAllChrome();
          // Compared against the route rather than the raw pathname, which on a
          // subpath deployment still carries the mount.
          if (currentRoute() !== '/home') navigate('/home');
          toast('You were removed from that community.', 'warn');
          return;
        }
        await refreshServerView();
      } catch (ex) {
        // Throwing here used to stop the handler before it repainted, which left
        // the community sidebar showing the last thing it knew about: a role
        // change, a new channel, a member leaving. That sidebar is the one piece
        // of chrome that is on screen everywhere, and it going quiet looks like
        // nothing happened.
        onStale('This community')(ex);
        return;
      }
      try {
        renderAllChrome();
      } catch {
        // The data is current and the repaint is what failed, so this is a
        // different problem from the one above and the stale warning would be
        // wrong. The next event paints it.
      }
    });
  }
}
wireCommunityEvents();

// The catch-then-rethrow this used to wrap is gone: it rethrew exactly what it was
// given. What matters is that these two are different functions and callers pick
// deliberately - ensureServer for "put this community in state", reloadServer for
// "I changed it, so fetch it again".
function ensureServer(serverId) {
  return enterServer(serverId);
}

export { pickReaction, wireCommunityEvents, ensureServer, reloadServer };
