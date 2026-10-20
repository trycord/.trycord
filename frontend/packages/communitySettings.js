// The community settings rules, shared by the desk and the phone.
//
// Three things live here, and nothing else:
//
//   1. The catalogue of sections the community settings console is made of.
//      Both clients show the same sections, in the same order, under the same
//      headings, because the catalogue is written once.
//
//   2. The catalogue of the routes that configure a community: every address
//      the server offers for changing a community, with the method, the call
//      that performs it and the surface that reaches it. This is the index
//      the parity check reads. A route added to the server and not to this
//      catalogue is a route nobody can reach, and the check says so.
//
//   3. The calls for the routes the platform's API module does not carry.
//      They go through the same request() everything else uses, so the
//      authorisation, the error shape and the failover are decided in one
//      place.
//
// The module holds no view and no element: it is rules, and both clients
// draw their own.

import { request } from './api.js';

// -- the sections -------------------------------------------------------------

// The sections of the console, in the order they are shown.
//
// `group` is the heading a section sits under, and `icon` is one of the
// icons the platform carries. A section is reached at
// /server/:id/settings/<id>.
export const COMMUNITY_SECTIONS = [
  {
    id: 'overview', label: 'Overview', icon: 'grid', group: 'This community',
    blurb: 'The name, the welcome, the rules and who the community is for',
  },
  {
    id: 'appearance', label: 'Appearance', icon: 'image', group: 'This community',
    blurb: 'The icon and the banner',
  },
  {
    id: 'channels', label: 'Channels', icon: 'hash', group: 'Structure',
    blurb: 'Create, rename and reorder the channels',
  },
  {
    id: 'categories', label: 'Categories', icon: 'layers', group: 'Structure',
    blurb: 'Group the channels, and what each group may do',
  },
  {
    id: 'members', label: 'Members', icon: 'users', group: 'Access',
    blurb: 'Everyone here, and who is about',
  },
  {
    id: 'roles', label: 'Roles', icon: 'shield', group: 'Access',
    blurb: 'What each role may manage, and what a channel overrides',
  },
  {
    id: 'invites', label: 'Invites', icon: 'mail', group: 'Access',
    blurb: 'The codes that let someone in',
  },
  {
    id: 'moderation', label: 'Moderation', icon: 'flag', group: 'Safety',
    blurb: 'Bans, timeouts and removing a member',
  },
  {
    id: 'voice', label: 'Voice', icon: 'volume', group: 'This community',
    blurb: 'The voice channels of this community',
  },
  {
    id: 'ownership', label: 'Ownership', icon: 'crown', group: 'Safety',
    blurb: 'Hand the community on, or end it',
  },
  {
    id: 'analytics', label: 'Analytics', icon: 'chart', group: 'Reach',
    blurb: 'What happened here, in numbers the server could measure',
  },
  {
    id: 'integrations', label: 'Integrations', icon: 'rocket', group: 'Reach',
    blurb: 'Webhooks, bot applications and the commands they answer',
  },
];

export function communitySection(id) {
  return COMMUNITY_SECTIONS.find((section) => section.id === id) || null;
}

// The sections as the console groups them.
export function communitySectionGroups() {
  const groups = new Map();
  for (const section of COMMUNITY_SECTIONS) {
    const list = groups.get(section.group) || [];
    list.push(section);
    groups.set(section.group, list);
  }
  return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
}

// -- the routes ---------------------------------------------------------------

// Every route that configures a community, and every route the console reads.
//
// `call` is the name of the client function that performs it: either a method
// of the platform's API module (updateServer) or one of the calls below
// (communityApi.rotateWebhookSecret). `surfaces` names the places that reach
// it: a section of this console, or another page of the client.
//
// The routes that are deliberately absent are the ones that are not about a
// community's configuration: creating one, joining it by its permanent code
// and leaving it are its lifecycle, and each has a page of its own. The
// parity check carries the same list, and says so there.
export const COMMUNITY_ROUTES = [
  // The community itself.
  { id: 'servers.read', method: 'GET', path: '/api/servers/:id', call: 'server', surfaces: ['overview'] },
  { id: 'servers.identity', method: 'PATCH', path: '/api/servers/:id', call: 'updateServer', surfaces: ['overview'] },
  { id: 'servers.settingsRead', method: 'GET', path: '/api/servers/:id/settings', call: 'readSettings', surfaces: ['overview'] },
  { id: 'servers.settingsWrite', method: 'PATCH', path: '/api/servers/:id/settings', call: 'updateServerSettings', surfaces: ['overview'] },
  { id: 'servers.icon', method: 'POST', path: '/api/servers/:id/icon', call: 'setServerImage', surfaces: ['appearance'] },
  { id: 'servers.iconRemove', method: 'DELETE', path: '/api/servers/:id/icon', call: 'removeServerImage', surfaces: ['appearance'] },
  { id: 'servers.banner', method: 'POST', path: '/api/servers/:id/banner', call: 'setServerImage', surfaces: ['appearance'] },
  { id: 'servers.bannerRemove', method: 'DELETE', path: '/api/servers/:id/banner', call: 'removeServerImage', surfaces: ['appearance'] },
  { id: 'servers.remove', method: 'DELETE', path: '/api/servers/:id', call: 'deleteServer', surfaces: ['ownership'] },
  { id: 'servers.transfer', method: 'POST', path: '/api/servers/:id/transfer', call: 'transferServer', surfaces: ['ownership'] },

  // The people of the community.
  { id: 'servers.members', method: 'GET', path: '/api/servers/:id/members', call: 'serverMembers', surfaces: ['members', 'moderation'] },
  { id: 'servers.nickname', method: 'PATCH', path: '/api/servers/:id/members/:userId/nickname', call: 'setNickname', surfaces: ['moderation', 'members'] },
  { id: 'servers.kick', method: 'POST', path: '/api/servers/:id/kick', call: 'kickMember', surfaces: ['moderation'] },
  { id: 'servers.ban', method: 'POST', path: '/api/servers/:id/ban', call: 'banMember', surfaces: ['moderation'] },
  { id: 'servers.unban', method: 'POST', path: '/api/servers/:id/unban', call: 'unbanMember', surfaces: ['moderation'] },
  { id: 'servers.bans', method: 'GET', path: '/api/servers/:id/bans', call: 'bans', surfaces: ['moderation'] },
  { id: 'servers.timeout', method: 'POST', path: '/api/servers/:id/timeout', call: 'timeoutMember', surfaces: ['moderation'] },

  // The channels.
  { id: 'channels.read', method: 'GET', path: '/api/servers/:serverId/channels', call: 'channels', surfaces: ['channels', 'categories'] },
  { id: 'channels.create', method: 'POST', path: '/api/servers/:serverId/channels', call: 'createChannel', surfaces: ['channels'] },
  { id: 'channels.update', method: 'PATCH', path: '/api/servers/:serverId/channels/:channelId', call: 'updateChannel', surfaces: ['channels'] },
  { id: 'channels.reorder', method: 'POST', path: '/api/servers/:serverId/channels/reorder', call: 'reorderChannels', surfaces: ['channels'] },
  { id: 'channels.remove', method: 'DELETE', path: '/api/servers/:serverId/channels/:channelId', call: 'deleteChannel', surfaces: ['channels'] },
  { id: 'channels.overridesRead', method: 'GET', path: '/api/servers/:serverId/channels/:channelId/overrides', call: 'channelOverrides', surfaces: ['roles', 'channels'] },
  { id: 'channels.overridesWrite', method: 'PUT', path: '/api/servers/:serverId/channels/:channelId/overrides/:permission', call: 'setChannelOverride', surfaces: ['roles', 'channels'] },

  // The categories.
  { id: 'categories.read', method: 'GET', path: '/api/servers/:serverId/categories', call: 'categories', surfaces: ['categories'] },
  { id: 'categories.create', method: 'POST', path: '/api/servers/:serverId/categories', call: 'createCategory', surfaces: ['categories'] },
  { id: 'categories.update', method: 'PATCH', path: '/api/servers/:serverId/categories/:categoryId', call: 'updateCategory', surfaces: ['categories'] },
  { id: 'categories.reorder', method: 'POST', path: '/api/servers/:serverId/categories/reorder', call: 'reorderCategories', surfaces: ['categories'] },
  { id: 'categories.remove', method: 'DELETE', path: '/api/servers/:serverId/categories/:categoryId', call: 'deleteCategory', surfaces: ['categories'] },
  { id: 'categories.overridesRead', method: 'GET', path: '/api/servers/:serverId/categories/:categoryId/overrides', call: 'categoryOverrides', surfaces: ['categories', 'roles'] },
  { id: 'categories.overridesWrite', method: 'PUT', path: '/api/servers/:serverId/categories/:categoryId/overrides/:permission', call: 'setCategoryOverride', surfaces: ['categories', 'roles'] },

  // The roles.
  { id: 'roles.read', method: 'GET', path: '/api/servers/:serverId/roles', call: 'roles', surfaces: ['roles'] },
  { id: 'roles.permissions', method: 'GET', path: '/api/servers/:serverId/roles/permissions', call: 'rolePermissions', surfaces: ['roles'] },
  { id: 'roles.create', method: 'POST', path: '/api/servers/:serverId/roles', call: 'createRole', surfaces: ['roles'] },
  { id: 'roles.update', method: 'PATCH', path: '/api/servers/:serverId/roles/:roleId', call: 'updateRole', surfaces: ['roles'] },
  { id: 'roles.reorder', method: 'POST', path: '/api/servers/:serverId/roles/reorder', call: 'reorderRoles', surfaces: ['roles'] },
  { id: 'roles.remove', method: 'DELETE', path: '/api/servers/:serverId/roles/:roleId', call: 'deleteRole', surfaces: ['roles'] },
  { id: 'roles.assign', method: 'POST', path: '/api/servers/:serverId/roles/:roleId/assign', call: 'assignRole', surfaces: ['roles'] },
  { id: 'roles.unassign', method: 'DELETE', path: '/api/servers/:serverId/roles/:roleId/assign/:userId', call: 'unassignRole', surfaces: ['roles'] },

  // The invites.
  { id: 'invites.read', method: 'GET', path: '/api/servers/:serverId/invites', call: 'invites', surfaces: ['invites'] },
  { id: 'invites.create', method: 'POST', path: '/api/servers/:serverId/invites', call: 'createInvite', surfaces: ['invites'] },
  { id: 'invites.remove', method: 'DELETE', path: '/api/servers/:serverId/invites/:inviteId', call: 'deleteInvite', surfaces: ['invites'] },

  // The webhooks.
  { id: 'webhooks.read', method: 'GET', path: '/api/servers/:serverId/webhooks', call: 'webhooks', surfaces: ['integrations'] },
  { id: 'webhooks.create', method: 'POST', path: '/api/servers/:serverId/webhooks', call: 'createWebhook', surfaces: ['integrations'] },
  { id: 'webhooks.update', method: 'PATCH', path: '/api/servers/:serverId/webhooks/:webhookId', call: 'updateWebhook', surfaces: ['integrations'] },
  { id: 'webhooks.rotate', method: 'POST', path: '/api/servers/:serverId/webhooks/:webhookId/rotate-secret', call: 'rotateWebhookSecret', surfaces: ['integrations'] },
  { id: 'webhooks.deliveries', method: 'GET', path: '/api/servers/:serverId/webhooks/:webhookId/deliveries', call: 'webhookDeliveries', surfaces: ['integrations'] },
  { id: 'webhooks.remove', method: 'DELETE', path: '/api/servers/:serverId/webhooks/:webhookId', call: 'deleteWebhook', surfaces: ['integrations'] },

  // The bot applications and the commands they answer.
  { id: 'apps.read', method: 'GET', path: '/api/servers/:serverId/apps', call: 'apps', surfaces: ['integrations'] },
  { id: 'apps.create', method: 'POST', path: '/api/servers/:serverId/apps', call: 'createApp', surfaces: ['integrations'] },
  { id: 'apps.update', method: 'PATCH', path: '/api/servers/:serverId/apps/:appId', call: 'updateApp', surfaces: ['integrations'] },
  { id: 'apps.remove', method: 'DELETE', path: '/api/servers/:serverId/apps/:appId', call: 'deleteApp', surfaces: ['integrations'] },
  { id: 'apps.commandsRead', method: 'GET', path: '/api/servers/:serverId/apps/:appId/commands', call: 'appCommands', surfaces: ['integrations'] },
  { id: 'apps.commandsWrite', method: 'PUT', path: '/api/servers/:serverId/apps/:appId/commands', call: 'setAppCommand', surfaces: ['integrations'] },
  { id: 'apps.commandRemove', method: 'DELETE', path: '/api/servers/:serverId/apps/:appId/commands/:commandId', call: 'deleteAppCommand', surfaces: ['integrations'] },

  // What the community did.
  { id: 'analytics.read', method: 'GET', path: '/api/servers/:serverId/analytics', call: 'analytics', surfaces: ['analytics'] },
];

const ROUTE_BY_ID = new Map(COMMUNITY_ROUTES.map((route) => [route.id, route]));

// The address of one route, with its parameters filled in.
export function communityRouteUrl(routeId, params) {
  const route = ROUTE_BY_ID.get(routeId);
  if (!route) throw new Error('unknown community route: ' + routeId);
  return route.path.replace(/:([A-Za-z_]+)/g, (_match, name) => {
    const value = params ? params[name] : undefined;
    if (value === undefined || value === null) {
      throw new Error('the route ' + routeId + ' needs a ' + name);
    }
    return encodeURIComponent(String(value));
  });
}

// -- the calls ----------------------------------------------------------------

// The calls the platform's API module does not carry.
//
// They are here rather than in the API module because the API module is not
// this file's to change, and because both clients need them: a rule that
// exists on the desk and not on the phone is a rule one of them does not
// have.
export const communityApi = {
  // The community's own settings, read back as they stand.
  //
  // Without this the interface cannot show the guidelines as they are: a box
  // that cannot be read is a box that is written blind.
  readSettings: (serverId) => request('GET', communityRouteUrl('servers.settingsRead', { id: serverId })),

  // A member's name in this community.
  setNickname: (serverId, userId, nickname) => request(
    'PATCH',
    communityRouteUrl('servers.nickname', { id: serverId, userId }),
    { body: { nickname } },
  ),

  // What each permission is allowed to do in one channel, and in one
  // category. Three states: inherit, allow, deny.
  channelOverrides: (serverId, channelId) => request(
    'GET',
    communityRouteUrl('channels.overridesRead', { serverId, channelId }),
  ),
  setChannelOverride: (serverId, channelId, permission, effect) => request(
    'PUT',
    communityRouteUrl('channels.overridesWrite', { serverId, channelId, permission }),
    { body: { effect } },
  ),
  categoryOverrides: (serverId, categoryId) => request(
    'GET',
    communityRouteUrl('categories.overridesRead', { serverId, categoryId }),
  ),
  setCategoryOverride: (serverId, categoryId, permission, effect) => request(
    'PUT',
    communityRouteUrl('categories.overridesWrite', { serverId, categoryId, permission }),
    { body: { effect } },
  ),

  // What each webhook delivered, and what the endpoint answered.
  webhookDeliveries: (serverId, webhookId) => request(
    'GET',
    communityRouteUrl('webhooks.deliveries', { serverId, webhookId }),
  ),

  // The bot applications of the community.
  apps: (serverId) => request('GET', communityRouteUrl('apps.read', { serverId })),
  createApp: (serverId, body) => request('POST', communityRouteUrl('apps.create', { serverId }), { body }),
  updateApp: (serverId, appId, body) => request(
    'PATCH',
    communityRouteUrl('apps.update', { serverId, appId }),
    { body },
  ),
  deleteApp: (serverId, appId) => request('DELETE', communityRouteUrl('apps.remove', { serverId, appId })),
  appCommands: (serverId, appId) => request('GET', communityRouteUrl('apps.commandsRead', { serverId, appId })),
  setAppCommand: (serverId, appId, body) => request(
    'PUT',
    communityRouteUrl('apps.commandsWrite', { serverId, appId }),
    { body },
  ),
  deleteAppCommand: (serverId, appId, commandId) => request(
    'DELETE',
    communityRouteUrl('apps.commandRemove', { serverId, appId, commandId }),
  ),
};

// -- the rules ----------------------------------------------------------------

// A secret is shown once, and once only.
//
// A webhook's secret and a bot's token are handed out once by the server and
// are not recoverable afterwards, so the interface has to be careful with the
// one copy it is given: it is shown, it is offered for copying, and it is
// never kept. What the interface shows afterwards is the fact that there is
// a secret, and the actions that change it.
export function maskSecret() {
  return '••••••••••••';
}

// Whether a value is the same as another one.
//
// The comparison is by text, so a field that has not been touched and a field
// that has been changed back are the same field, and the section is not
// dirty because of it.
export function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return String(a) === String(b);
}

// The bookkeeping a settings section keeps about what it has changed.
//
// The section knows whether it is dirty, and it knows which fields are
// dirty: that is what the console's warning is built on, and it is what
// stops an unchanged box from being written over.
export function createFormState(initial) {
  const original = Object.assign({}, initial || {});
  const current = Object.assign({}, initial || {});
  return {
    set(field, value) { current[field] = value; },
    value(field) { return current[field]; },
    original(field) { return original[field]; },
    changed(field) { return !sameValue(current[field], original[field]); },
    dirtyFields() {
      return Object.keys(current).filter((field) => !sameValue(current[field], original[field]));
    },
    isDirty() { return this.dirtyFields().length > 0; },
    commit() { Object.assign(original, current); },
  };
}

// A settings document: the notification defaults and the interaction
// settings are free-form text the instance keeps as it is written.
//
// A document that parses is shown as it is; a document that does not parse is
// shown as it is too - never dropped, never rewritten - and the reader is
// told what is wrong with it, so there is a way out of it.
export function readDocument(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  if (!text.trim()) return { ok: true, text: '', value: {}, empty: true };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, text, value: null, reason: 'A settings document has to be an object.' };
    }
    return { ok: true, text, value, empty: false };
  } catch {
    return {
      ok: false,
      text,
      value: null,
      reason: 'This is not valid JSON, so the instance cannot read it as a document.',
    };
  }
}

// The document as it would be written, pretty-printed when it can be.
export function writeDocument(document) {
  if (!document) return '';
  if (document.ok === false) return document.text;
  if (document.empty) return '';
  try { return JSON.stringify(document.value, null, 2); } catch { return document.text; }
}
