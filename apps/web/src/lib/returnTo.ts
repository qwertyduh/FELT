/**
 * Where to go after onboarding: the in-app path carried in the router state (kept across a reload),
 * else home. Anything that is not a plain in-app path is ignored.
 */
export function returnToFrom(state: unknown): string {
  const to = (state as { returnTo?: unknown } | null)?.returnTo;
  if (typeof to !== 'string' || !/^\/(?![/\\])/.test(to) || to.startsWith('/onboarding'))
    return '/';
  return to;
}
