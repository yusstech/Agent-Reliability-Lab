import { createHash } from 'node:crypto';

/** SHA-256 of a session token; only this digest is ever stored or looked up. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
