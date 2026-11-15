// util.ts — small shared helpers for the forge.
//
// Everything time-like in this file is deterministic: the trial hands the entry
// MAKEFUN_TRIAL_NOW (an ISO timestamp) and the forge never reads the wall clock
// for anything it returns. When the variable is absent (a local boot), a fixed
// epoch is used so a local run is reproducible too.

import { createHash } from 'node:crypto';

/** The trial's "now": an ISO string from MAKEFUN_TRIAL_NOW, else a fixed default. */
export const TRIAL_NOW_ISO: string = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return '2023-11-14T22:13:20.000Z';
})();

/** The trial's "now" as epoch seconds (used for git commit timestamps). */
export const TRIAL_NOW_EPOCH: number = Math.floor(new Date(TRIAL_NOW_ISO).getTime() / 1000);

/** SHA-1 hex of bytes. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of UTF-8 text. */
export function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Standard base64 of bytes. */
export function b64encodeBytes(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Decode base64, ignoring the whitespace GitHub wraps long values at. */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Whether `value` is a 40-character lowercase hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0'.repeat(40);

/** A per-process counter used for X-GitHub-Request-Id (deterministic per request order). */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Escape a string for safe inclusion in a JSON error message (no control chars leak). */
export function safeText(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}
