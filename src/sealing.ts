/**
 * Encrypted, self-contained tokens, so the server needs no database.
 *
 * Every OAuth artifact (registered client, pending authorization request, MFA hand-off,
 * authorization code, access token, refresh token) is a JSON payload encrypted and
 * authenticated with AES-256-GCM under TOKEN_SECRET. The type prefix is bound in as
 * additional authenticated data and repeated in the payload, so one kind of token can't
 * be accepted as another. The first secret encrypts; every secret can decrypt (rotation).
 * Rotating out all old secrets invalidates everything.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const PREFIXES = {
  client: 'nmc_',
  authreq: 'nmq_',
  mfa: 'nmm_',
  code: 'nmk_',
  access: 'nma_',
  refresh: 'nmr_',
} as const;
export type TokenType = keyof typeof PREFIXES;

const MIN_SECRET_LENGTH = 32;

export class Sealer {
  private keys: Buffer[];

  constructor(secrets: string[]) {
    if (secrets.length === 0) throw new Error('At least one secret is required');
    for (const s of secrets) {
      if (s.length < MIN_SECRET_LENGTH) throw new Error(`TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.keys = secrets.map(s => Buffer.from(hkdfSync('sha256', s, '', 'nanit-mcp/seal/v1', 32)));
  }

  seal(typ: TokenType, payload: Record<string, unknown>, ttlSeconds: number | null): string {
    const data: Record<string, unknown> = { ...payload, typ };
    if (ttlSeconds !== null) data.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const prefix = PREFIXES[typ];
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0], iv);
    cipher.setAAD(Buffer.from(prefix));
    const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return prefix + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  /** The payload, or null if the token is not a valid, unexpired token of this type. */
  open<T extends Record<string, any> = Record<string, any>>(typ: TokenType, token: string | undefined | null): T | null {
    const prefix = PREFIXES[typ];
    if (!token || !token.startsWith(prefix)) return null;
    const raw = Buffer.from(token.slice(prefix.length), 'base64url');
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(prefix));
        decipher.setAuthTag(tag);
        const data = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
        if (!data || typeof data !== 'object' || data.typ !== typ) return null;
        if (typeof data.exp === 'number' && data.exp < Date.now() / 1000) return null;
        return data as T;
      } catch {
        // wrong key or tampered; try the next key
      }
    }
    return null;
  }
}

/** A short stable id for a long value (used to bind codes and tokens to a client). */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
