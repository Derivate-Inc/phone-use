import { createDeviceHandle, type Device, type DeviceBackend, type DeviceCore } from '@phone-use/sdk';
import { readJson, trimUrl } from './http.ts';
import { RemoteDeviceBackend } from './remote-backend.ts';
import type { CloudClientOptions, CreateSandboxOptions, Sandbox } from './types.ts';

const DEFAULT_TIMEOUT_MS = 300_000;

export class CloudClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: CloudClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.PHONE_USE_CLOUD_URL;
    const token = opts.token ?? process.env.PHONE_USE_CLOUD_TOKEN;
    if (!baseUrl) throw new Error('PHONE_USE_CLOUD_URL or baseUrl is required');
    if (!token) throw new Error('PHONE_USE_CLOUD_TOKEN or token is required');
    this.baseUrl = trimUrl(baseUrl);
    this.token = token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    });
  }

  async list(): Promise<Sandbox[]> {
    return readJson<Sandbox[]>(await this.request('/v1/sandboxes'));
  }

  async get(id: string): Promise<Sandbox> {
    return readJson<Sandbox>(await this.request(`/v1/sandboxes/${encodeURIComponent(id)}`));
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const response = await this.request('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        platform: options.platform,
        ttlMs: options.ttlMs,
        idleTimeoutMs: options.idleTimeoutMs,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const sandbox = await readJson<Sandbox>(response);
    return options.wait === false
      ? sandbox
      : this.waitFor(sandbox.id, ['running', 'failed'], options.timeoutMs, options.signal);
  }

  async close(
    id: string,
    opts: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Sandbox> {
    const sandbox = await readJson<Sandbox>(
      await this.request(`/v1/sandboxes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
    return opts.wait === false
      ? sandbox
      : this.waitFor(id, ['closed', 'failed'], opts.timeoutMs, opts.signal);
  }

  async waitFor(
    id: string,
    statuses: Sandbox['status'][],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<Sandbox> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const sandbox = await this.get(id);
      if (statuses.includes(sandbox.status)) return sandbox;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for sandbox ${id}: ${sandbox.status}`);
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, 750);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error('aborted'));
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }

  async connect(
    id: string,
    opts: {
      idleTimeoutMs?: number | false;
      coreFactory?: (backend: DeviceBackend) => DeviceCore;
    } = {},
  ): Promise<Device> {
    const sandbox = await this.get(id);
    if (sandbox.status !== 'running' || !sandbox.connection) {
      throw new Error(`sandbox ${id} is ${sandbox.status}, not running`);
    }
    const backend = new RemoteDeviceBackend({
      ...sandbox.connection,
      fetch: this.fetchImpl,
    });
    return createDeviceHandle({
      id: sandbox.id,
      platform: sandbox.platform,
      name: sandbox.name,
      backend,
      createdByUs: true,
      idleTimeoutMs: opts.idleTimeoutMs ?? false,
      coreFactory: opts.coreFactory,
      doClose: async () => {
        await this.close(sandbox.id);
      },
    });
  }

  async launch(options: CreateSandboxOptions): Promise<Device> {
    const sandbox = await this.create({ ...options, wait: true });
    return this.connect(sandbox.id);
  }
}
