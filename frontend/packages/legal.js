// The legal versions a registration is recorded against.
//
// The server refuses a registration whose termsVersion or privacyVersion does
// not match the documents in force, so a client that writes a version of its
// own is refused the day the documents change. The versions are therefore read
// from the instance (GET /api/legal) and sent back exactly as they were read.
//
// This module is deliberately free of imports: it is the rule that both client
// modules apply, and it is worth testing without a browser or a network.

const LEGAL_DOCUMENTS = [
  { key: 'terms', route: '/terms', label: 'Terms of Service' },
  { key: 'privacy', route: '/privacy', label: 'Privacy Policy' },
];

// The two versions in force, or null when the instance has not said. A partial
// answer is no answer: half a version is refused by the server exactly as
// firmly as none.
export function legalVersions(legal) {
  if (!legal || !legal.termsVersion || !legal.privacyVersion) return null;
  return {
    termsVersion: String(legal.termsVersion),
    privacyVersion: String(legal.privacyVersion),
  };
}

// The registration body, carrying the versions the instance published. The
// caller's fields are kept; the versions are added, never replaced by a
// constant.
export function withLegalVersions(body, legal) {
  const versions = legalVersions(legal);
  const out = Object.assign({}, body || {});
  if (!versions) return out;
  out.termsVersion = versions.termsVersion;
  out.privacyVersion = versions.privacyVersion;
  return out;
}

// Whether an answer is the server refusing a registration because the
// documents moved on. The reader is told to reload rather than shown a bare
// error, because nothing they typed is wrong: the version they accepted is.
export function isStaleLegalError(error) {
  if (!error) return false;
  if (error.code && error.code !== 'VALIDATION_ERROR') return false;
  const message = String(error.message || '').toLowerCase();
  return message.indexOf('terms of service') !== -1 || message.indexOf('privacy policy') !== -1;
}

// The public pages the documents live on, for the acceptance control to link
// to. They are on the public site rather than inside the application, because
// a reader who has not accepted them yet has no account to read them with.
export function legalDocuments() {
  return LEGAL_DOCUMENTS.map((doc) => ({ key: doc.key, route: doc.route, label: doc.label }));
}

export default { legalVersions, withLegalVersions, isStaleLegalError, legalDocuments };
