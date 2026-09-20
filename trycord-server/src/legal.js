// Legal document versions. The client shows these exact versions at
// registration; the server only accepts acceptance records that match.
// Bump a version (and the updated date) whenever the corresponding public
// document changes meaningfully. Existing accounts are grandfathered:
// NULL acceptance columns mean "registered before versioned terms".
module.exports = {
  TERMS_VERSION: '1.0',
  PRIVACY_VERSION: '1.0',
  LEGAL_UPDATED: '2026-09-20',
};
