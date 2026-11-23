// The screens the phone answers.
//
// One map: a module, the view it exports, and the addresses that view answers.
// The table is read before any view is imported, so an address never pulls the
// whole app into the first paint. Every entry is lazy for the same reason.

const lazy = (module, name) => async (ctx) => {
  const view = await import(module);
  return view[name](ctx);
};

const VIEWS = [
  ['./chats.js', 'renderChats', ['dms', 'friends', 'home']],
  ['./convo.js', 'renderConvo', ['dms.conversation', 'community.channel']],
  ['./places.js', 'renderPlaces', ['communities']],
  ['./places.js', 'renderInvite', ['invite']],
  ['./you.js', 'renderYou', ['you']],
  ['./alerts.js', 'renderAlerts', ['notifications']],
  ['./person.js', 'renderPerson', ['profile']],
  ['./place.js', 'renderPlace', ['community', 'community.legacy', 'community.members']],
  ['./place.js', 'renderFederatedCommunity', ['federated.community']],
  ['./workspace.js', 'renderWorkspace', [
    'community.workspace', 'community.workspace.files',
    'community.workspace.spaces', 'community.workspace.space',
    'community.workspace.documents', 'community.workspace.document',
    'community.workspace.boards', 'community.workspace.board',
    'community.workspace.card', 'community.workspace.events',
    'community.workspace.event', 'community.workspace.polls',
    'community.workspace.poll', 'community.workspace.file',
  ]],
  ['./auth.js', 'renderAuth', [
    'login', 'register', 'twoStep', 'forgot', 'resetPassword', 'verifyEmail',
  ]],
  ['./settings.js', 'renderSettings', [
    'settings', 'settings.security', 'settings.privacy', 'settings.notifications',
    'settings.encryption', 'settings.appearance', 'settings.language',
    'settings.backend', 'settings.updates',
  ]],
  ['./placetools.js', 'renderPlacetools', [
    'community.roles', 'community.invites', 'community.categories',
    'community.channelPins', 'community.new', 'community.onboarding',
  ]],
  ['./placesettings.js', 'renderPlaceSettings', [
    'community.settings', 'community.settings.overview', 'community.settings.appearance',
    'community.settings.emojis', 'community.settings.channels', 'community.settings.categories',
    'community.settings.members', 'community.settings.roles', 'community.settings.invites',
    'community.settings.moderation', 'community.settings.rules', 'community.settings.voice',
    'community.settings.ownership', 'community.settings.analytics', 'community.settings.integrations',
  ]],
  ['./tools.js', 'renderConsole', [
    'developer', 'developer.keys', 'developer.applications', 'developer.documentation',
    'applications', 'applications.keys', 'applications.applications',
    'applications.dashboard', 'applications.documentation',
    'federation', 'status', 'instances',
  ]],
  ['./tools.js', 'renderMisc', ['discover', 'search', 'collections', 'extensions']],
  ['./tools.js', 'renderMenu', ['menu']],
  ['./tools.js', 'renderSupport', ['support']],
  ['./tools.js', 'renderLegal', ['legal']],
  ['./admin.js', 'renderAdmin', [
    'admin', 'admin.users', 'admin.approvals', 'admin.communities', 'admin.reports',
    'admin.appeals', 'admin.audit', 'admin.gdpr', 'admin.announcements', 'admin.pages',
    'admin.settings', 'admin.database', 'admin.continuum', 'admin.voice',
    'admin.diagnostics', 'admin.incidents', 'admin.federation',
  ]],
];

export const RENDERERS = Object.fromEntries(
  VIEWS.flatMap(([module, name, pages]) => pages.map((id) => [id, lazy(module, name)]))
);

export default { RENDERERS };
