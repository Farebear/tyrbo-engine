// TYRBO-PATCH: the auth bridge is the single point where the piece reads its
// credentials, so these tests pin the exact contract the server-side injection
// (worker controller + validation) and the engine's context-version flattening
// depend on.
import { describe, expect, it } from 'vitest';
import { toTrelloCreds } from './auth';

describe('toTrelloCreds', () => {
  it('maps flattened props (validate callback / context V0) to { key, token }', () => {
    // The platform key is injected as `username`, the user token as `password`;
    // an extra `token` prop from the stored value is ignored.
    expect(
      toTrelloCreds({ token: 'user-token', username: 'platform-key', password: 'user-token' }),
    ).toEqual({ key: 'platform-key', token: 'user-token' });
  });

  it('maps the full { type, props } value (actions/dropdowns, context V1)', () => {
    expect(
      toTrelloCreds({
        type: 'CUSTOM_AUTH',
        props: { token: 'user-token', username: 'platform-key', password: 'user-token' },
      }),
    ).toEqual({ key: 'platform-key', token: 'user-token' });
  });

  it('maps a legacy BYO BASIC_AUTH value (with a type discriminator) the same way', () => {
    expect(
      toTrelloCreds({ type: 'BASIC_AUTH', username: 'byo-key', password: 'byo-token' }),
    ).toEqual({ key: 'byo-key', token: 'byo-token' });
  });

  it('throws when the platform key was not injected (only a token is present)', () => {
    expect(() => toTrelloCreds({ token: 'user-token' })).toThrow();
    expect(() => toTrelloCreds({ type: 'CUSTOM_AUTH', props: { token: 'user-token' } })).toThrow();
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
