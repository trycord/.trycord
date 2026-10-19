/**
 * The legal documents.
 *
 * The rules the web client holds in frontend/packages/legal.js, and the
 * client has to hold too: the versions come from the instance, and a
 * registration without them is not sent.
 */

import {ApiError} from '../errors';
import {isStaleLegalError, legalVersions, withLegalVersions} from '../legal';
import {LegalInfo} from '../types';

const legal: LegalInfo = {
  termsVersion: '1.0',
  privacyVersion: '1.0',
  updated: '2026-09-20',
};

describe('the legal versions', () => {
  it('reads the versions the instance says', () => {
    expect(legalVersions(legal)).toEqual({
      termsVersion: '1.0',
      privacyVersion: '1.0',
    });
  });

  it('has no versions when the instance has not said', () => {
    expect(legalVersions(null)).toBeNull();
    expect(
      legalVersions({termsVersion: '', privacyVersion: '1.0', updated: null}),
    ).toBeNull();
  });

  it('puts the versions into a registration body', () => {
    const body = withLegalVersions({username: 'ada'}, legal);

    expect(body.username).toBe('ada');
    expect(body.termsVersion).toBe('1.0');
    expect(body.privacyVersion).toBe('1.0');
  });

  it('puts nothing into a body when the instance has not said', () => {
    const body = withLegalVersions({username: 'ada'}, null);

    expect(body.username).toBe('ada');
    expect(body.termsVersion).toBeUndefined();
    expect(body.privacyVersion).toBeUndefined();
  });
});

describe('a stale legal answer', () => {
  it('is recognised when the documents moved on', () => {
    const stale = new ApiError(
      'VALIDATION_ERROR',
      'please accept the current Terms of Service and Privacy Policy',
      400,
    );

    expect(isStaleLegalError(stale)).toBe(true);
  });

  it('is not recognised for any other validation failure', () => {
    const other = new ApiError('VALIDATION_ERROR', 'username taken', 400);

    expect(isStaleLegalError(other)).toBe(false);
  });

  it('is not recognised for an answer that is not a validation failure', () => {
    const conflict = new ApiError('CONFLICT', 'Terms of Service changed', 409);

    expect(isStaleLegalError(conflict)).toBe(false);
  });

  it('is not recognised when there is no answer', () => {
    expect(isStaleLegalError(null)).toBe(false);
  });
});
