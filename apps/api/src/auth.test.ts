import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Auth } from './auth.ts';

const file = () => join(mkdtempSync(join(tmpdir(), 'way-auth-')), 'auth.json');

describe('account', () => {
  it('starts as admin / way and signs sessions', () => {
    const auth = new Auth(file());
    expect(auth.usesDefaultPassword).toBe(true);
    expect(auth.login('1.1.1.1', 'admin', 'nope')).toBeNull();
    const token = auth.login('1.1.1.1', 'Admin', 'way')!;
    expect(auth.verify(token)).toBe('admin');
    expect(auth.verify(`${token}x`)).toBeNull();
    expect(auth.verify(undefined)).toBeNull();
  });

  it('changes the password, keeps it across restarts and logs other sessions out', () => {
    const path = file();
    const auth = new Auth(path);
    const old = auth.login('ip', 'admin', 'way')!;
    expect(auth.changePassword('wrong', 'nouveau-secret')).toBeNull();
    const fresh = auth.changePassword('way', 'nouveau-secret')!;
    expect(auth.verify(old)).toBeNull();
    expect(auth.verify(fresh)).toBe('admin');

    const again = new Auth(path);
    expect(again.usesDefaultPassword).toBe(false);
    expect(again.verify(fresh)).toBe('admin');
    expect(again.login('ip', 'admin', 'way')).toBeNull();
    expect(again.login('ip', 'admin', 'nouveau-secret')).not.toBeNull();
  });

  it('locks a client out after repeated failures', () => {
    const auth = new Auth(file());
    for (let i = 0; i < 5; i++) auth.login('9.9.9.9', 'admin', 'guess');
    expect(auth.locked('9.9.9.9')).toBeGreaterThan(0);
    expect(auth.login('9.9.9.9', 'admin', 'way')).toBeNull();
    expect(auth.login('8.8.8.8', 'admin', 'way')).not.toBeNull();
  });
});
