import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, AuthUnavailableError, type AuthErrorCode, type AuthUser } from './verify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every non-public route. */
    user: Pick<AuthUser, 'userId' | 'isAnonymous'>;
  }
  interface FastifyContextConfig {
    /** Opt a route out of the default-deny auth hook. */
    public?: boolean;
  }
}

/** RFC 7235: the scheme is case-insensitive. One or more spaces, then the token. */
const BEARER_RE = /^bearer +(\S+)$/i;

/** Pure header parsing; throws AuthError('missing' | 'malformed'). */
export function extractBearer(header: string | string[] | undefined): string {
  if (header === undefined) throw new AuthError('missing');
  // Node drops duplicate Authorization headers, but inject() and proxies can still yield arrays.
  if (typeof header !== 'string') throw new AuthError('malformed');
  const trimmed = header.trim();
  if (trimmed === '' || /^bearer$/i.test(trimmed)) throw new AuthError('missing'); // empty token
  const match = BEARER_RE.exec(trimmed);
  if (!match?.[1]) throw new AuthError('malformed'); // wrong scheme, extra parts
  return match[1];
}

/** Node silently keeps only the first duplicate Authorization header; look at the raw list instead. */
function countAuthorizationHeaders(rawHeaders: string[]): number {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'authorization') n++;
  }
  return n;
}

function deny(reply: FastifyReply, code: AuthErrorCode): FastifyReply {
  return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized', code });
}

/**
 * Default-deny auth. Registered as a global `onRequest` hook, which also runs for unknown routes
 * (Fastify's 404 handler); `request.is404` lets those through so they stay 404 instead of 401.
 * That reveals nothing: a 404 carries no data. Routes opt out with `config: { public: true }`.
 * Register after CORS so preflight (OPTIONS) requests are answered before this hook runs.
 */
export function registerAuth(
  app: FastifyInstance,
  verify: (token: string) => Promise<AuthUser>,
): void {
  app.decorateRequest('user');
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // NOTE: not-found handlers run unauthenticated; they must never return data.
    if (request.is404 || request.routeOptions.config.public === true) return;
    try {
      if (countAuthorizationHeaders(request.raw.rawHeaders) > 1) throw new AuthError('malformed');
      const user = await verify(extractBearer(request.headers.authorization));
      request.user = { userId: user.userId, isAnonymous: user.isAnonymous };
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        request.log.warn({ error: err.reason }, 'auth unavailable'); // class name only
        return reply.code(503).header('Retry-After', '5').send({ error: 'auth_unavailable' });
      }
      const code: AuthErrorCode = err instanceof AuthError ? err.code : 'invalid';
      request.log.info({ authCode: code }, 'auth failed'); // code only, never the token
      return deny(reply, code);
    }
  });
}
