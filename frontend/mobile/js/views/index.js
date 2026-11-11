// The screens the phone answers.
//
// Read by the router before any view is imported, so the address table does
// not pull the whole app into the first paint. Every entry is lazy: the view
// arrives when its address does.

const lazy = (module, name) => async (ctx) => {
  const view = await import(module);
  return view[name](ctx);
};

export const RENDERERS = {
  // The doors.
  dms: lazy('./chats.js', 'renderChats'),
  'dms.conversation': lazy('./convo.js', 'renderConvo'),
  communities: lazy('./places.js', 'renderPlaces'),
  you: lazy('./you.js', 'renderYou'),
  notifications: lazy('./alerts.js', 'renderAlerts'),

  // The profile page: one address that is always a person's.
  profile: lazy('./person.js', 'renderPerson'),

  // A place, by slug or by id, and its channel.
  community: lazy('./place.js', 'renderPlace'),
  'community.legacy': lazy('./place.js', 'renderPlace'),
  'community.channel': lazy('./convo.js', 'renderConvo'),

  // The place's files. The desk's studio holds the rest of the workspace.
  'community.workspace': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.files': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.spaces': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.space': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.documents': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.document': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.boards': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.board': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.card': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.events': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.event': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.polls': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.poll': lazy('./workspace.js', 'renderWorkspace'),
  'community.workspace.file': lazy('./workspace.js', 'renderWorkspace'),
  'community.members': lazy('./place.js', 'renderPlace'),

  // Friends has its own address on the desk; on the phone the Chats door
  // answers for it, so an address typed or carried over still lands.
  friends: lazy('./chats.js', 'renderChats'),

  // The desk's home is the phone's Chats.
  home: lazy('./chats.js', 'renderChats'),

  // The front door and its siblings, all gates, all raw.
  invite: lazy('./places.js', 'renderInvite'),
  login: lazy('./auth.js', 'renderAuth'),
  register: lazy('./auth.js', 'renderAuth'),
  twoStep: lazy('./auth.js', 'renderAuth'),
  forgot: lazy('./auth.js', 'renderAuth'),
  resetPassword: lazy('./auth.js', 'renderAuth'),
  verifyEmail: lazy('./auth.js', 'renderAuth'),

  // The instance console. Every section the desk offers is answered on the
  // phone too; the server decides who may read it.
  admin: lazy('./admin.js', 'renderAdmin'),
  'admin.users': lazy('./admin.js', 'renderAdmin'),
  'admin.approvals': lazy('./admin.js', 'renderAdmin'),
  'admin.communities': lazy('./admin.js', 'renderAdmin'),
  'admin.reports': lazy('./admin.js', 'renderAdmin'),
  'admin.appeals': lazy('./admin.js', 'renderAdmin'),
  'admin.audit': lazy('./admin.js', 'renderAdmin'),
  'admin.gdpr': lazy('./admin.js', 'renderAdmin'),
  'admin.announcements': lazy('./admin.js', 'renderAdmin'),
  'admin.pages': lazy('./admin.js', 'renderAdmin'),
  'admin.settings': lazy('./admin.js', 'renderAdmin'),
  'admin.database': lazy('./admin.js', 'renderAdmin'),
  'admin.continuum': lazy('./admin.js', 'renderAdmin'),
  'admin.voice': lazy('./admin.js', 'renderAdmin'),
  'admin.diagnostics': lazy('./admin.js', 'renderAdmin'),
  'admin.incidents': lazy('./admin.js', 'renderAdmin'),
  'admin.federation': lazy('./admin.js', 'renderAdmin'),
};

export default { RENDERERS };