/**
 * Depth-agnostic, Buffer-safe redaction of secret-like keys in log objects. The logger uses no
 * pino `redact` at all (its wildcard paths throw on Buffers nested in Fastify's error payloads);
 * this module is the only redaction layer and covers header names and tokens at any depth.
 */
const SECRET_KEYS = new Set(
  [
    'token',
    'access_token',
    'accesstoken',
    'refresh_token',
    'refreshtoken',
    'jwt',
    'password',
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'apikey',
    'api_key',
    'x-api-key',
    'secret',
    'service_role_key',
  ].map(normalizeKey),
);

export const REDACTED = '[Redacted]';
export const MAX_DEPTH = 8;

/** Case-insensitive; `-` and `_` are ignored so `Access-Token`, `accessToken` and `access_token` match. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Plain = `Object.prototype` or null prototype. Shared with the logger so both agree. */
export function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Left for pino to serialise untouched: no own secret-bearing fields, and unsafe to copy. */
function isOpaque(value: object): boolean {
  return (
    ArrayBuffer.isView(value) || // Buffer, typed arrays, DataView
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Promise
  );
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (isOpaque(value)) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]'; // unseen subtree: drop it rather than risk a leak
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item: unknown) => walk(item, depth + 1, seen));
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Errors keep their non-enumerable core fields; every other own enumerable prop is copied,
    // which flattens class instances into plain objects so secret keys on them are caught too.
    if (value instanceof Error) {
      out.type = value.name;
      out.message = value.message;
      out.stack = value.stack;
      if ('cause' in value) out.cause = walk(value.cause, depth + 1, seen);
    } else if (!isPlainObject(value) && typeof source.toJSON === 'function') {
      return walk((source.toJSON as () => unknown)(), depth + 1, seen);
    }
    for (const key of Object.keys(value)) {
      out[key] = SECRET_KEYS.has(normalizeKey(key)) ? REDACTED : walk(source[key], depth + 1, seen);
    }
    return out;
  } catch {
    return '[Unserializable]';
  } finally {
    seen.delete(value); // only true ancestors count as cycles; shared siblings are fine
  }
}

/** Returns a sanitised copy. Never throws; an unserialisable root becomes `{ logSanitizeError: true }`. */
export function sanitizeLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    const out = walk(obj, 0, new WeakSet());
    if (typeof out === 'object' && out !== null && !Array.isArray(out)) {
      return out as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { logSanitizeError: true };
}

/** Sanitise any value (object, array, primitive); never throws, unserialisable -> marker object. */
export function sanitizeValue(value: unknown): unknown {
  try {
    return walk(value, 0, new WeakSet());
  } catch {
    return { logSanitizeError: true };
  }
}
