// The E2EE half of the API.
//
// The server's routes are under /api/e2ee, and the names here are the
// server's route names, so a reader can match them against
// backend/src/routes/e2ee.js line by line.
//
// Every route is authenticated, every route that touches one account's
// material refuses another account's, and no route accepts a plaintext
// message body: what crosses it is a sealed ratchet state, a sealed key, or
// a public key.
//
// The request function is injected rather than imported, so this module does
// not decide where the client talks to and a check can answer for it.

/**
 * The E2EE routes, over a request function.
 *
 * @param {object} transport { request(method, path, options), upload(path, formData) }
 */
export function createE2eeApi(transport) {
  const request = transport.request;
  const upload = transport.upload;
  const json = (method, path, body) => request(method, path, { body });
  const at = (path) => encodeURIComponent(path);

  return {
    // ---- devices -------------------------------------------------------------

    listDevices: () => request('GET', '/api/e2ee/devices'),
    registerDevice: (body) => json('POST', '/api/e2ee/devices', body),
    device: (deviceId) => request('GET', '/api/e2ee/devices/' + at(deviceId)),
    revokeDevice: (deviceId) => request('DELETE', '/api/e2ee/devices/' + at(deviceId)),

    // ---- prekeys -------------------------------------------------------------

    publishPrekeys: (body) => json('POST', '/api/e2ee/prekeys', body),
    prekeyBundle: (deviceId) => request('GET', '/api/e2ee/prekeys/' + at(deviceId)),
    claimPrekey: (deviceId, prekeyId) => json('POST', '/api/e2ee/prekeys/claim', { deviceId, prekeyId }),
    releasePrekeys: (deviceId) => json('POST', '/api/e2ee/prekeys/release', { deviceId }),

    // ---- sessions ------------------------------------------------------------

    createSession: (body) => json('POST', '/api/e2ee/sessions', body),
    listSessions: (deviceId) => request('GET', '/api/e2ee/sessions?deviceId=' + at(deviceId)),
    session: (sessionId) => request('GET', '/api/e2ee/sessions/' + at(sessionId)),
    updateSession: (sessionId, body) => json('PATCH', '/api/e2ee/sessions/' + at(sessionId), body),
    closeSession: (sessionId) => request('DELETE', '/api/e2ee/sessions/' + at(sessionId)),

    // ---- conversations -------------------------------------------------------

    publishConversationKey: (conversationId, body) =>
      json('POST', '/api/e2ee/conversations/' + at(conversationId) + '/key', body),
    conversationKey: (conversationId, deviceId) =>
      request('GET', '/api/e2ee/conversations/' + at(conversationId) + '/key?deviceId=' + at(deviceId)),
    conversationState: (conversationId) =>
      request('GET', '/api/e2ee/conversations/' + at(conversationId) + '/state'),

    // ---- attachments ---------------------------------------------------------

    registerAttachment: (body) => json('POST', '/api/e2ee/attachments', body),
    attachment: (attachmentId) => request('GET', '/api/e2ee/attachments/' + at(attachmentId)),
    // The ciphertext of a file, with the key sealed to the member devices.
    // The id is the client's, because the key is sealed to the attachment
    // before the file is uploaded.
    uploadAttachment: (formData) => {
      if (!upload) throw new Error('this client cannot upload files');
      return upload('/api/e2ee/attachments/upload', formData);
    },

    // ---- backup and recovery -------------------------------------------------

    saveBackup: (body) => json('POST', '/api/e2ee/backup', body),
    fetchBackup: () => request('GET', '/api/e2ee/backup'),
    recoverDevice: (body) => json('POST', '/api/e2ee/recovery', body),

    // ---- safety numbers ------------------------------------------------------

    safetyNumber: (userId) => request('GET', '/api/e2ee/safety-number?userId=' + at(userId)),
  };
}

export default createE2eeApi;
