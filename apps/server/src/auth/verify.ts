import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/** Only asymmetric algorithms: HS* (shared secret) and `none` are never accepted. */
export const ALLOWED_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];
/** Tolerated clock skew between this server and the token issuer, in seconds. */
export const CLOCK_TOLERANCE_SECONDS = 10;
/** Upper bound on token size; real Supabase tokens are ~1KB. */
export const MAX_TOKEN_LENGTH = 4096;
/** Matches Supabase's default 1h `jwt_expiry`; a longer configured expiry would be rejected here. */
export const MAX_TOKEN_AGE_SECONDS = 3600;
export const AUDIENCE = 'authenticated';

export type AuthErrorCode = 'missing' | 'malformed' | 'expired' | 'invalid';

/** Carries only a machine code; the underlying reason is deliberately not exposed. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(`auth failed: ${code}`);
    this.name = 'AuthError';
  }
}

/**
 * The signing keys could not be fetched (timeout, network error, invalid JWKS). Mapped to
 * 503 `auth_unavailable` + `Retry-After`. Clients must sign out ONLY on 401, never on 503.
 */
export class AuthUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('auth unavailable');
    this.name = 'AuthUnavailableError';
  }
}

export interface AuthUser {
  userId: string;
  isAnonymous: boolean;
  sessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** jose key sets also expose `jwks()` (cached key list); injected plain functions may not. */
export type KeySet = JWTVerifyGetKey & { jwks?: () => { keys?: unknown[] } | undefined };

export interface VerifierOptions {
  /** `${SUPABASE_URL}/auth/v1` */
  issuer: string;
  /** Key source. Injectable for tests; production uses {@link createRemoteKeySet}. */
  keySet: KeySet;
  /** Called with the error class name only when key retrieval fails (never the token). */
  onKeyError?: (name: string) => void;
}

/** Cached remote JWKS: 10 min cache, 30 s cooldown between refetches, 5 s fetch timeout. */
export function createRemoteKeySet(jwksUrl: string): KeySet {
  return createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 10 * 60_000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
}

export function issuerFor(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
}

/**
 * Algorithm layer 1: reject unparseable headers and any alg outside the allow-list (incl. `none`
 * and HS*) before the key set is consulted. Throws AuthError('malformed' | 'invalid').
 */
export function assertAllowedAlgorithm(token: string): void {
  let alg: unknown;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new AuthError('malformed'); // not a parseable JWT at all
  }
  if (typeof alg !== 'string' || !ALLOWED_ALGORITHMS.includes(alg)) {
    throw new AuthError('invalid');
  }
}

/**
 * Algorithm layer 2 plus signature and claim checks. jose's `algorithms` option is an independent
 * allow-list, so it still rejects a disallowed alg even if layer 1 is bypassed. Throws raw jose errors.
 */
export function verifySignedJwt(
  token: string,
  keySet: KeySet,
  issuer: string,
): Promise<JWTPayload> {
  return jwtVerify(token, keySet, {
    algorithms: ALLOWED_ALGORITHMS,
    issuer,
    audience: AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    requiredClaims: ['exp', 'iat', 'iss', 'aud', 'sub'],
    maxTokenAge: MAX_TOKEN_AGE_SECONDS, // too old -> expired; iat in the future -> invalid
  }).then((r) => r.payload);
}

export function createVerifier(opts: VerifierOptions): (token: string) => Promise<AuthUser> {
  return async function verifyAccessToken(token: string): Promise<AuthUser> {
    if (typeof token !== 'string' || token.length === 0) throw new AuthError('missing');
    if (token.length > MAX_TOKEN_LENGTH) throw new AuthError('malformed');

    assertAllowedAlgorithm(token); // layer 1: before any key lookup

    let payload: JWTPayload;
    try {
      payload = await verifySignedJwt(token, opts.keySet, opts.issuer);
    } catch (err) {
      throw toAuthError(err, opts.keySet, opts.onKeyError);
    }

    // Supabase issues a plain string; reject multi-audience tokens even if they include ours.
    if (payload.aud !== AUDIENCE) throw new AuthError('invalid');
    if (payload.role !== 'authenticated') throw new AuthError('invalid');
    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) {
      throw new AuthError('invalid');
    }
    const user: AuthUser = {
      userId: payload.sub.toLowerCase(),
      isAnonymous: payload.is_anonymous === true,
    };
    if (typeof payload.session_id === 'string' && UUID_RE.test(payload.session_id)) {
      user.sessionId = payload.session_id.toLowerCase();
    }
    return user;
  };
}

/** True only when the set can report its keys (jose local/remote sets can) and has none. */
function keySetIsEmpty(keySet: KeySet): boolean {
  if (typeof keySet.jwks !== 'function') return false;
  const keys = keySet.jwks()?.keys;
  if (!Array.isArray(keys)) return true;
  // an entry without `kty` is not a key at all
  return !keys.some((k: unknown) => typeof k === 'object' && k !== null && 'kty' in k);
}

function toAuthError(
  err: unknown,
  keySet: KeySet,
  onKeyError?: (name: string) => void,
): AuthError | AuthUnavailableError {
  if (err instanceof errors.JWTExpired) return new AuthError('expired');
  if (err instanceof errors.JWTClaimValidationFailed) return new AuthError('invalid');
  if (err instanceof errors.JWSInvalid || err instanceof errors.JWTInvalid) {
    return new AuthError('malformed');
  }
  // An unknown kid is the caller's problem (e.g. a rotated-out key): 401.
  if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) {
    // ...unless the key set has no keys at all: that is our misconfiguration, so 503 (a 401 would
    // make clients sign out and lose their anonymous identity).
    if (keySetIsEmpty(keySet)) {
      onKeyError?.('EmptyJWKS');
      return new AuthUnavailableError('EmptyJWKS');
    }
    return new AuthError('invalid');
  }
  // Key retrieval problems (timeout, bad JWKS, network failure) are ours, not the caller's.
  // Fail closed with 503; only the error class name is kept.
  const generic = err instanceof errors.JOSEError && err.code === 'ERR_JOSE_GENERIC';
  if (
    err instanceof errors.JWKSTimeout ||
    err instanceof errors.JWKSInvalid ||
    generic ||
    !(err instanceof errors.JOSEError)
  ) {
    const reason = err instanceof Error ? err.name : 'unknown';
    onKeyError?.(reason);
    return new AuthUnavailableError(reason);
  }
  return new AuthError('invalid');
}
