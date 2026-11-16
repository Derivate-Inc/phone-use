/** Fixed-window, process-local abuse ceiling with bounded memory. */
export function windowLimiter(max: number, windowMs: number, maxKeys = 10_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);
    if (entry && now < entry.resetAt) {
      // Rejected requests need not grow the counter indefinitely.
      if (entry.count >= max) return false;
      entry.count += 1;
      return true;
    }
    if (!entry && hits.size >= maxKeys) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      // New caller identities cannot grow memory without bound. Existing
      // callers keep their own quota until their windows expire.
      if (hits.size >= maxKeys) return false;
    }
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  };
}
