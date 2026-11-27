export interface ApiErrorInit {
  status: number;
  code: string;
  body?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor({ status, code, body }: ApiErrorInit) {
    super(`API ${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type RefreshResult = 'ok' | 'rejected' | 'transient';

export interface ApiCallOptions {
  /**
   * false: a 503 is returned at once. Use for calls that are not safe to repeat: the server may
   * have done part of the work (a retried `POST /rooms` can leave an orphan room behind).
   */
  retryUnavailable?: boolean;
}

export interface ApiFetchDeps {
  baseUrl: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** 'rejected': the refresh token is dead (sign out). 'transient': network/5xx (do not sign out). */
  refreshSession: () => Promise<RefreshResult>;
  signOut: () => Promise<void>;
  /** Retries after the first attempt on 503. Default 4. */
  maxUnavailableRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Retry-After as delta-seconds or an HTTP date -> ms, or null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function codeOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { code?: unknown; error?: unknown };
    if (typeof b.code === 'string') return b.code;
    if (typeof b.error === 'string') return b.error;
  }
  return 'unknown';
}

/**
 * Authenticated server calls (`Authorization: Bearer <access_token>`).
 *  - 401 expired/invalid: refresh the session once (shared by concurrent calls), retry once; if
 *    that still fails, sign out. A transient refresh failure surfaces the error without signing out.
 *  - 401 missing/malformed (or anything else): no loop, throws ApiError.
 *  - 503: exponential backoff (Retry-After honoured, capped), bounded attempts, never signs out;
 *    no retry at all with `retryUnavailable: false`.
 */
export function createApiFetch(deps: ApiFetchDeps) {
  const maxRetries = deps.maxUnavailableRetries ?? 4;
  const baseDelay = deps.baseDelayMs ?? 500;
  const maxDelay = deps.maxDelayMs ?? 8000;
  let refreshing: Promise<RefreshResult> | null = null;

  const refreshOnce = (): Promise<RefreshResult> => {
    refreshing ??= deps.refreshSession().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  async function send(
    path: string,
    init: RequestInit | undefined,
    options: ApiCallOptions | undefined,
  ): Promise<Response> {
    const retries = options?.retryUnavailable === false ? 0 : maxRetries;
    for (let attempt = 0; ; attempt++) {
      const token = await deps.getAccessToken();
      if (!token) throw new ApiError({ status: 401, code: 'no_session' });
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      let res: Response;
      try {
        res = await deps.fetch(`${deps.baseUrl}${path}`, { ...init, headers });
      } catch {
        throw new ApiError({ status: 0, code: 'network' });
      }
      if (res.status !== 503 || attempt >= retries) return res;
      const fromHeader = parseRetryAfter(res.headers.get('Retry-After'));
      const backoff = baseDelay * 2 ** attempt;
      await deps.sleep(Math.min(fromHeader ?? backoff, maxDelay));
    }
  }

  const isDead401 = async (res: Response): Promise<boolean> => {
    if (res.status !== 401) return false;
    const code = codeOf(await readJson(res.clone()));
    return code === 'expired' || code === 'invalid';
  };

  return async function apiFetch<T = unknown>(
    path: string,
    init?: RequestInit,
    options?: ApiCallOptions,
  ): Promise<T> {
    let res = await send(path, init, options);
    if (await isDead401(res)) {
      const refreshed = await refreshOnce();
      if (refreshed === 'transient') throw new ApiError({ status: 401, code: 'refresh_failed' });
      if (refreshed === 'ok') {
        res = await send(path, init, options);
        if (!(await isDead401(res))) return finish<T>(res);
      }
      await deps.signOut();
    }
    return finish<T>(res);
  };
}

async function finish<T>(res: Response): Promise<T> {
  const body = await readJson(res);
  if (!res.ok) throw new ApiError({ status: res.status, code: codeOf(body), body });
  return body as T;
}
