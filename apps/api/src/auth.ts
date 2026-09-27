import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

// A single account guards the settings page. The password is stored as a
// scrypt hash; sessions are signed cookies, so they survive restarts.
// Forgotten password: delete auth.json and the account is back to admin / way.

export const DEFAULT_USER = 'admin';
const DEFAULT_PASSWORD = 'way';
export const COOKIE = 'way_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

interface Account {
  username: string;
  salt: string;
  hash: string;
  /** Signs session cookies; renewed on password change (logs out other devices). */
  secret: string;
  isDefault: boolean;
}

const hashPassword = (password: string, salt: string) => scryptSync(password, salt, 64).toString('hex');

function newAccount(username: string, password: string, isDefault: boolean): Account {
  const salt = randomBytes(16).toString('hex');
  return { username, salt, hash: hashPassword(password, salt), secret: randomBytes(32).toString('hex'), isDefault };
}

export class Auth {
  private account: Account;
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private file: string) {
    if (existsSync(file)) {
      this.account = JSON.parse(readFileSync(file, 'utf8')) as Account;
    } else {
      this.account = newAccount(DEFAULT_USER, DEFAULT_PASSWORD, true);
      this.save();
    }
  }

  get usesDefaultPassword(): boolean {
    return this.account.isDefault;
  }

  /** Remaining lock in ms for this client, 0 when it may try again. */
  locked(ip: string): number {
    const f = this.failures.get(ip);
    return f && f.until > Date.now() ? f.until - Date.now() : 0;
  }

  /** Returns a session token, or null (and counts a failure). */
  login(ip: string, username: string, password: string): string | null {
    if (this.locked(ip)) return null;
    if (username.trim().toLowerCase() === this.account.username && this.check(password)) {
      this.failures.delete(ip);
      return this.issue();
    }
    const f = this.failures.get(ip) ?? { count: 0, until: 0 };
    f.count++;
    if (f.count >= MAX_FAILURES) {
      f.count = 0;
      f.until = Date.now() + LOCK_MS;
    }
    this.failures.set(ip, f);
    return null;
  }

  /** Changes the password and returns a fresh token for the caller. */
  changePassword(current: string, next: string): string | null {
    if (!this.check(current)) return null;
    this.account = newAccount(this.account.username, next, false);
    this.save();
    return this.issue();
  }

  /** Username of a valid session cookie, or null. */
  verify(token: string | undefined): string | null {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = this.sign(body);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { u: string; exp: number };
      return exp > Date.now() && u === this.account.username ? u : null;
    } catch {
      return null;
    }
  }

  setCookie(reply: FastifyReply, req: FastifyRequest, token: string | null): void {
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    const value = token
      ? `${COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}`
      : `${COOKIE}=; Max-Age=0`;
    reply.header('Set-Cookie', `${value}; Path=/; HttpOnly; SameSite=Strict${secure}`);
  }

  private check(password: string): boolean {
    const got = Buffer.from(hashPassword(password, this.account.salt), 'hex');
    const want = Buffer.from(this.account.hash, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private issue(): string {
    const body = Buffer.from(
      JSON.stringify({ u: this.account.username, exp: Date.now() + SESSION_DAYS * 86_400_000 }),
    ).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.account.secret).update(body).digest('base64url');
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.account, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported (Windows) */
    }
  }
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
