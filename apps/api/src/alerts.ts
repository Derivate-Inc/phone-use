import type { CloudStore } from './store.ts';

export type AlertOptions = {
  store: CloudStore;
  /** Resend API key; alerting is a no-op without it. */
  resendApiKey?: string | undefined;
  /** Operator inbox for outage mail. */
  to?: string | undefined;
  from?: string | undefined;
  /** A host silent for longer than this is down. */
  thresholdMs?: number | undefined;
};

/**
 * Fleet alerting: mails the operator when a worker goes silent past the
 * threshold and again when it recovers. One mail per outage — the down set
 * tracks which hosts have already been reported.
 */
export function startHostAlerts(opts: AlertOptions): () => void {
  if (!opts.resendApiKey || !opts.to) return () => undefined;
  const threshold = opts.thresholdMs ?? 120_000;
  const down = new Set<string>();

  const send = async (subject: string, text: string): Promise<void> => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: opts.from ?? 'alerts@phoneuse.dev', to: opts.to, subject, text }),
    });
    if (!res.ok) console.error('alert mail failed:', res.status, await res.text());
  };

  const sweep = async (): Promise<void> => {
    for (const host of opts.store.listHosts()) {
      const silent = host.lastSeenMsAgo > threshold;
      if (silent && !down.has(host.id)) {
        down.add(host.id);
        await send(
          `worker down: ${host.id}`,
          `Worker ${host.id} (${host.platform}, capacity ${host.capacity}) last seen ${Math.round(host.lastSeenMsAgo / 1000)}s ago — past the ${Math.round(threshold / 1000)}s threshold. Live phones on it will drain; new creates will fail once no other host covers the platform.`,
        );
      } else if (!silent && down.has(host.id)) {
        down.delete(host.id);
        await send(`worker recovered: ${host.id}`, `Worker ${host.id} is heartbeating again.`);
      }
    }
  };

  const timer = setInterval(() => void sweep().catch((e) => console.error('alert sweep failed:', e)), 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
