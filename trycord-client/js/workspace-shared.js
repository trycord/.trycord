import Api from './api.js';
import State from './state.js';
import Realtime from './realtime.js';

import { currentServerId, enterServer, isAuthed, leaveServerContext, refreshServerView } from './state.js';
import { showEmojiPicker, toast } from './ui.js';
import { renderAllChrome } from './shell.js';
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
          if ((location.pathname || '/') !== '/home') navigate('#/home');
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
