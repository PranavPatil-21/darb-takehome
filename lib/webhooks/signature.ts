import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC webhook signature verification (bonus item in the brief).
 *
 * Both providers sign the *raw request body*, so the route must read the body as text
 * and verify before parsing — re-serialising parsed JSON produces different bytes and
 * the signature will never match.
 */

export type SignatureVerdict =
  | { valid: true; reason: 'VERIFIED' | 'SKIPPED_UNSIGNED_ALLOWED' }
  | { valid: false; reason: 'MISSING_SIGNATURE' | 'BAD_SIGNATURE' | 'NO_SECRET_CONFIGURED' };

/** Constant-time comparison. A naive `===` here leaks the secret one byte at a time. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function computeSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Verifies the signature header against the raw body.
 *
 * When `allowUnsigned` is true (the development default, set by ALLOW_UNSIGNED_WEBHOOKS)
 * an absent header is accepted so the sample curl scripts work without signing. A header
 * that is *present but wrong* is always rejected — permissiveness must never extend to
 * accepting a forgery.
 */
export function verifySignature(options: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string | undefined;
  allowUnsigned: boolean;
}): SignatureVerdict {
  const { rawBody, signatureHeader, secret, allowUnsigned } = options;

  if (!signatureHeader) {
    return allowUnsigned
      ? { valid: true, reason: 'SKIPPED_UNSIGNED_ALLOWED' }
      : { valid: false, reason: 'MISSING_SIGNATURE' };
  }

  if (!secret) return { valid: false, reason: 'NO_SECRET_CONFIGURED' };

  return safeEquals(computeSignature(rawBody, secret), signatureHeader)
    ? { valid: true, reason: 'VERIFIED' }
    : { valid: false, reason: 'BAD_SIGNATURE' };
}

export function allowUnsignedWebhooks(): boolean {
  return process.env.ALLOW_UNSIGNED_WEBHOOKS !== 'false';
}
