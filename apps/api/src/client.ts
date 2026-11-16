import {
  CLOUD_WAITLIST_CODE,
  CloudWaitlistError,
  createDeviceHandle,
  type Device,
  type DeviceBackend,
  type DeviceCore,
} from '@phone-use/sdk';
import { CloudApiError, readJson, trimUrl } from './http.ts';
import { RemoteDeviceBackend } from './remote-backend.ts';
import type { CloudClientOptions, CreateSandboxOptions, Sandbox } from './types.ts';

const DEFAULT_TIMEOUT_MS = 300_000;

export class CloudClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: CloudClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.PHONE_USE_CLOUD_URL;
    if (!baseUrl) throw new Error('PHONE_USE_CLOUD_URL or baseUrl is required');
    this.baseUrl = trimUrl(baseUrl);
    // A client with no token can still be built: asking it for a phone is
    // answered by the waitlist (see create); everything else needs the token.
    this.token = opts.token ?? process.env.PHONE_USE_CLOUD_TOKEN;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.token) throw new Error('PHONE_USE_CLOUD_TOKEN or token is required');
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        // Tells the control plane which surface asked (cli, mcp or sdk).
        'x-phone-use-client': 'sdk',
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

  /**
   * Create a cloud phone. Cloud phones are on a waitlist: with no token, or
   * from an account that is not approved, this throws CloudWaitlistError,
   * whose message names the local device to use instead and the waitlist link.
   */
  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    if (!this.token) {
      await this.reportLoggedOutAttempt(options.platform);
      throw new CloudWaitlistError({ surface: 'sdk', platform: options.platform, signedIn: false });
    }
    const response = await this.request('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        platform: options.platform,
        ttlMs: options.ttlMs,
        idleTimeoutMs: options.idleTimeoutMs,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const sandbox = await readJson<Sandbox & { waitlistUrl?: string }>(response).catch((error) => {
      if (error instanceof CloudApiError && error.code === CLOUD_WAITLIST_CODE) {
        throw new CloudWaitlistError(
          { surface: 'sdk', platform: options.platform, signedIn: true, waitlistUrl: error.waitlistUrl },
          { cause: error },
        );
      }
      throw error;
    });
    return options.wait === false
      ? sandbox
      : this.waitFor(sandbox.id, ['running', 'failed'], options.timeoutMs, options.signal);
  }

  /**
   * A create with no token never reaches POST /v1/sandboxes, so the control
   * plane is told here that someone asked: platform and client kind only.
   * Best-effort, and it never delays or fails the caller for long.
   */
  private async reportLoggedOutAttempt(platform: Sandbox['platform']): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/v1/waitlist/attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, client: 'sdk' }),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
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
