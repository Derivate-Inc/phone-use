/**
 * A skill or map name becomes a filename under ~/.phone-use, and names arrive
 * from model output and from imported atlas bundles — so `../config` would
 * otherwise overwrite the user's config (whose PHONE_USE_* keys decide where
 * credentials are sent). One flat, dot-free-of-traversal token, nothing else.
 */
export function assertSafeName(name: unknown, kind: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][\w.-]{0,79}$/.test(name) || name.includes('..')) {
    throw new Error(
      `invalid ${kind} name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-' (max 80 chars, no '..')`,
    );
  }
  return name;
}
