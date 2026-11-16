const active = new Set<string>();

/** Process-local exclusivity; cross-process callers must provision separate devices. */
export function claimDevice(platform: string, id: string): () => void {
  const key = `${platform}:${id}`;
  if (active.has(key))
    throw new Error(`Device ${id} already has an active workflow or prompt in this process`);
  active.add(key);
  return () => {
    active.delete(key);
  };
}
