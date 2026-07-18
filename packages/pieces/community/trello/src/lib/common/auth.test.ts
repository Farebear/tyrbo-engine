// TYRBO-PATCH: the auth bridge is the single point where the piece reads its
// credentials, so these tests pin the exact contract the engine resolver and the
// server validation injection depend on.
import { describe, expect, it } from 'vitest';
import { toTrelloCreds } from './auth';

describe('toTrelloCreds', () => {
  it('maps the injected value (platform key + user token) to { key, token }', () => {
    // The engine resolver rewrites a Tyrbo Trello connection to this shape; the
    // API key arrives as `username`, never pasted by the user.
    expect(toTrelloCreds({ username: 'platform-key', password: 'user-token' })).toEqual({
      key: 'platform-key',
      token: 'user-token',
    });
  });

  it('maps a legacy BYO BASIC_AUTH value (with a type discriminator) the same way', () => {
    expect(
      toTrelloCreds({ type: 'BASIC_AUTH', username: 'byo-key', password: 'byo-token' }),
    ).toEqual({ key: 'byo-key', token: 'byo-token' });
  });

  it('throws when the platform key was not injected (only a token is present)', () => {
    expect(() => toTrelloCreds({ token: 'user-token' })).toThrow();
  });

  it('throws on an empty key or token', () => {
    expect(() => toTrelloCreds({ username: '', password: 'user-token' })).toThrow();
    expect(() => toTrelloCreds({ username: 'platform-key', password: '' })).toThrow();
  });

  it('throws on a non-object connection value', () => {
    expect(() => toTrelloCreds(undefined)).toThrow();
    expect(() => toTrelloCreds('platform-key:user-token')).toThrow();
  });
});
