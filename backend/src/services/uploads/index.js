// Uploads: what a file is, how much of it an account may store, and where each kind
// lives.
//
// Files are written through the storage service, never straight to disk, so the same
// code works on local disk or an S3-compatible bucket. Files are keyed by a generated id
// and a key that encodes the owner, never by the uploader's filename, and are validated
// by magic bytes before anything is written.
//
// This file is the composition root. The four modules under ./uploads/ each answer one
// question:
//
//   detect.js      what is this file? sniffing, naming, and the inline-serve policy
//   quota.js       how much may this account store in total?
//   attachments.js message attachments, including the pending lifecycle
//   identity.js    avatars, banners, community icons and community banners
//
// The call surface is unchanged from when all of it lived here, because that surface is
// what the routes already speak.

const detect = require('./detect');
const quota = require('./quota');
const attachments = require('./attachments');
const identity = require('./identity');

module.exports = {
  MAX_SIZE: detect.MAX_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE: detect.MAX_ATTACHMENTS_PER_MESSAGE,
  UNKNOWN_MIME: detect.UNKNOWN_MIME,
  isInlineMime: detect.isInlineMime,
  sanitizeIds: detect.sanitizeIds,

  QUOTA_BYTES: quota.QUOTA_BYTES,
  quota: quota.usage,

  store: attachments.store,
  attachToMessage: attachments.attachToMessage,
  getForMessage: attachments.getForMessage,
  getForMessages: attachments.getForMessages,
  getForDmMessage: attachments.getForDmMessage,
  getForDmMessages: attachments.getForDmMessages,
  authorized: attachments.authorized,
  removeFiles: attachments.removeFiles,
  purgePending: attachments.purgePending,
  openAttachment: attachments.open,

  storeProfileMedia: identity.storeProfileMedia,
  profileMedia: identity.profileMedia,
  removeProfileFile: identity.removeProfileFile,
  openProfileMedia: identity.openProfileMedia,
  storeServerMedia: identity.storeServerMedia,
  serverMedia: identity.serverMedia,
  removeServerFile: identity.removeServerFile,
  openServerMedia: identity.openServerMedia,
};
