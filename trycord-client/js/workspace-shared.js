// Shared plumbing for the community (server) surfaces.
//
// ensureServer, the reaction picker and the realtime community-room wiring are
// used by more than one feature module. They live here rather than being
// duplicated, so a change to how a community is entered or how reactions are
// inserted applies everywhere at once.
import Api from './api.js';
import State from './state.js';
import Realtime from './realtime.js';

import { currentServerId, enterServer, isAuthed, leaveServerContext, refreshServerView } from './state.js';
import { showEmojiPicker, toast } from './ui.js';
import { renderAllChrome } from './shell.js';

// The channel the conversation view currently has open.
//
// This is shared state: the conversation view sets it, and the reaction picker
// (which lives here) needs it to know which channel to attach a reaction to.
// It used to be a plain module-level variable because both lived in the same
// file; after the split that would mean two independent copies, and an imported
// binding cannot be assigned from the importing module anyway. So the state
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

// Community realtime wiring (subscribed once — module evaluates once).
// Structural events arrive on the server room; the handler refreshes state
// (serialized, so rapid events converge) and repaints the active view via
// its refresh hook. If WE were removed, drop context and go home.
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
          if (!location.hash.startsWith('#/home')) location.hash = '#/home';
          toast('You were removed from that community.', 'warn');
          return;
        }
        await refreshServerView();
        renderAllChrome();
      } catch { /* realtime refresh must never break the loop */ }
    });
  }
}
wireCommunityEvents();

function ensureServer(serverId) {
  return enterServer(serverId).catch((ex) => {
    throw ex;
  });
}

export { pickReaction, wireCommunityEvents, ensureServer };
