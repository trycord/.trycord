// The things a reader keeps for themselves.
//
// Two of them, and both belong to the reader:
//
//   templates    a named piece of text the reader inserts into a message
//   collections  a named list of saved messages, files and links
//
// A collection may be shared with the community it belongs to, and a shared
// collection is visible to that community's members and to nobody else. The
// server decides that; the client asks for the list and shows what the server
// said, which is why nothing here decides who may see what.
//
// The shortcut a template answers to is written with a leading mark - "!greet"
// - so a word that happens to match a template name is never swallowed out of a
// message the reader is writing.

import Api from './api.js';

// The mark that introduces a shortcut.
export const SHORTCUT_MARK = '!';

// A shortcut is one word: letters, digits, a dash or an underscore.
const SHORTCUT = /!([A-Za-z0-9_-]{1,32})(\s|$)/;

// ---- templates ---------------------------------------------------------------

// The reader's templates. They belong to the reader and to nobody else: the
// server answers the list from the owner.
export function listTemplates() {
  return Api.templates();
}

export function createTemplate(input) {
  return Api.createTemplate({
    name: String((input && input.name) || '').trim(),
    body: String((input && input.body) || ''),
    shortcut: String((input && input.shortcut) || '').trim() || null,
  });
}

export function updateTemplate(id, patch) {
  const body = {};
  if (patch && patch.name !== undefined) body.name = String(patch.name).trim();
  if (patch && patch.body !== undefined) body.body = String(patch.body);
  if (patch && patch.shortcut !== undefined) {
    body.shortcut = String(patch.shortcut).trim() || null;
  }
  return Api.updateTemplate(id, body);
}

export function removeTemplate(id) {
  return Api.deleteTemplate(id);
}

// The template a shortcut names, for a client that expands it.
export function templateByShortcut(shortcut) {
  const text = String(shortcut || '').trim().replace(new RegExp('^' + SHORTCUT_MARK), '');
  if (!text) return Promise.resolve(null);
  return Api.templateByShortcut(text).catch((error) => {
    if (error && error.status === 404) return null;
    throw error;
  });
}

// The template whose shortcut is this one, out of a list already read.
export function findByShortcut(list, shortcut) {
  const text = String(shortcut || '').trim().replace(new RegExp('^' + SHORTCUT_MARK), '');
  if (!text) return null;
  return (list || []).find((template) => template && template.shortcut === text) || null;
}

// Expand the shortcut at the end of a draft.
//
// The shortcut is expanded when the reader has finished the word - a space
// after it, or the end of the draft - so that the word can still be typed.
// The body replaces the whole "!shortcut" token, and the draft keeps whatever
// came before it.
export function expandShortcut(text, list) {
  const draft = String(text == null ? '' : text);
  const m = SHORTCUT.exec(draft);
  if (!m) return null;
  const template = findByShortcut(list, m[1]);
  if (!template) return null;
  const body = String(template.body == null ? '' : template.body);
  return {
    template,
    shortcut: m[1],
    text: draft.slice(0, m.index) + body + m[2],
  };
}

// ---- collections -------------------------------------------------------------

// The collections this reader may see: their own, and the shared ones in the
// communities they belong to.
export function listCollections() {
  return Api.collections();
}

// One collection and what is in it.
export function collection(id) {
  return Api.collection(id);
}

export function createCollection(input) {
  return Api.createCollection({
    serverId: String((input && input.serverId) || '').trim(),
    name: String((input && input.name) || '').trim(),
    visibility: (input && input.visibility) || 'private',
  });
}

export function updateCollection(id, patch) {
  const body = {};
  if (patch && patch.name !== undefined) body.name = String(patch.name).trim();
  if (patch && patch.visibility !== undefined) body.visibility = String(patch.visibility);
  return Api.updateCollection(id, body);
}

export function removeCollection(id) {
  return Api.deleteCollection(id);
}

export function addCollectionItem(id, item) {
  const body = { itemType: String((item && item.itemType) || '').trim().toLowerCase() };
  if (body.itemType === 'link') {
    body.itemRef = String((item && (item.itemRef || item.url)) || '').trim();
    if (item && item.title) body.title = String(item.title).trim();
  } else {
    body.itemId = String((item && item.itemId) || '').trim();
  }
  return Api.addCollectionItem(id, body);
}

export function removeCollectionItem(id, itemId) {
  return Api.removeCollectionItem(id, itemId);
}

// Does this reader own the collection? Only the owner may rename it, change
// who can see it, or put something in it.
export function isOwner(collection, userId) {
  if (!collection || !userId) return false;
  return String(collection.ownerId) === String(userId);
}

// What a collection's visibility means, in words a reader can act on.
export const VISIBILITY = {
  private: { label: 'Private', hint: 'Only you can see it' },
  community: { label: 'Shared', hint: 'The members of the community can see it' },
};

export function visibilityOf(collection) {
  const key = String((collection && collection.visibility) || 'private');
  return VISIBILITY[key] || VISIBILITY.private;
}

export default {
  SHORTCUT_MARK,
  listTemplates, createTemplate, updateTemplate, removeTemplate, templateByShortcut,
  findByShortcut, expandShortcut,
  listCollections, collection, createCollection, updateCollection, removeCollection,
  addCollectionItem, removeCollectionItem, isOwner, visibilityOf, VISIBILITY,
};
