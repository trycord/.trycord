/**
 * The legal documents.
 *
 * The server records the exact versions of the Terms and the Privacy Policy
 * that a person accepted, and refuses a registration whose versions are not
 * the ones in force. So the versions come from the instance, never from this
 * file, and the ones that were shown are the ones that are sent.
 *
 * The rules here are the same ones the web client holds, in
 * frontend/packages/legal.js.
 */

import {ApiError, isApiError} from './errors';
import {LegalInfo} from './types';

export interface LegalVersions {
  termsVersion: string;
  privacyVersion: string;
}

/**
 * The versions in force, or null when the instance has not said.
 *
 * A missing version is not a version. A registration sent without one is
 * refused by the server, and a reader told "please accept the current Terms"
 * when the screen never showed them is worse off than one told the truth.
 */
export function legalVersions(legal: LegalInfo | null): LegalVersions | null {
  if (!legal) return null;
  const termsVersion = String(legal.termsVersion || '').trim();
  const privacyVersion = String(legal.privacyVersion || '').trim();
  if (!termsVersion || !privacyVersion) return null;
  return {termsVersion, privacyVersion};
}

/**
 * Adds the accepted versions to a registration body.
 *
 * Nothing is added when the instance has not said which versions are in
 * force, so a body without versions stays without them rather than carrying
 * a guess.
 */
export function withLegalVersions<T extends Record<string, unknown>>(
  body: T,
  legal: LegalInfo | null,
): T & {termsVersion?: string; privacyVersion?: string} {
  const versions = legalVersions(legal);
  const out: T & {termsVersion?: string; privacyVersion?: string} = {...body};
  if (!versions) return out;
  out.termsVersion = versions.termsVersion;
  out.privacyVersion = versions.privacyVersion;
  return out;
}

/**
 * Whether an answer is the server refusing a registration because the
 * documents moved on.
 *
 * Nothing the person typed is wrong in that case - the version they accepted
 * is - so they are told to read the current documents rather than shown a
 * bare error.
 */
export function isStaleLegalError(error: unknown): boolean {
  if (!error) return false;
  if (isApiError(error)) {
    if (error.code && error.code !== 'VALIDATION_ERROR') return false;
    return mentionsDocuments(error.message);
  }
  if (error instanceof ApiError) {
    if (error.code && error.code !== 'VALIDATION_ERROR') return false;
    return mentionsDocuments(error.message);
  }
  return false;
}

function mentionsDocuments(message: string): boolean {
  const text = String(message || '').toLowerCase();
  return (
    text.indexOf('terms of service') !== -1 || text.indexOf('privacy policy') !== -1
  );
}
