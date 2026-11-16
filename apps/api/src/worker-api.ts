import { readJson, trimUrl } from './http.ts';
import type { ProvisionedResource, WorkerHost, WorkerJob } from './types.ts';

export class WorkerControlClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly hostId: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.baseUrl = trimUrl(baseUrl);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return readJson<T>(
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
  }

  register(host: WorkerHost): Promise<{ ok: true }> {
    return this.post('/v1/worker/register', host);
  }
  /** Sandbox ids the control plane still considers assigned to this host. */
  async liveSandboxIds(): Promise<string[]> {
    const res = await this.post('/v1/worker/sandboxes/live', { hostId: this.hostId });
    return (res as unknown as { ids?: string[] }).ids ?? [];
  }

  heartbeat(reserved = 0): Promise<{ ok: true }> {
    // `reserved` = warm-pool devices already occupying the host. Without it the
    // control plane schedules against nominal capacity and oversubscribes.
    return this.post('/v1/worker/heartbeat', { hostId: this.hostId, reserved });
  }
  async claim(): Promise<WorkerJob | undefined> {
    const result = await this.post<{ job: WorkerJob | null }>('/v1/worker/jobs/claim', {
      hostId: this.hostId,
    });
    return result.job ?? undefined;
  }
  completeCreate(id: string, resource: ProvisionedResource): Promise<unknown> {
    return this.post(`/v1/worker/jobs/${encodeURIComponent(id)}/complete`, {
      hostId: this.hostId,
      kind: 'create',
      deviceId: resource.deviceId,
      name: resource.name,
    });
  }
  completeDelete(id: string): Promise<unknown> {
    return this.post(`/v1/worker/jobs/${encodeURIComponent(id)}/complete`, {
      hostId: this.hostId,
      kind: 'delete',
    });
  }
  fail(id: string, error: unknown): Promise<unknown> {
    return this.post(`/v1/worker/jobs/${encodeURIComponent(id)}/fail`, {
      hostId: this.hostId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  touch(id: string, event?: { method: string; detail: string | null }): Promise<unknown> {
    return this.post(`/v1/worker/sandboxes/${encodeURIComponent(id)}/activity`, {
      hostId: this.hostId,
      ...(event ? { event } : {}),
    });
  }
}
