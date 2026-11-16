// Thin HTTP client for the Phone Use Cloud control plane — lives in the
// published CLI package so `phone-use create/list/env/close` work from npm.
// The server (and its richer client with device handles) stays in the private
// @phone-use/cloud workspace; wire shapes are shared by convention.

export class CloudApiError extends Error {
  readonly status: number;
  readonly code?: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.code = code;
  }
}

export type SandboxConnection = {
  endpoint: string;
  token: string;
  deviceId: string;
  capabilities: string[];
};

export type Sandbox = {
  id: string;
  platform: 'ios' | 'android';
  status: 'queued' | 'preparing' | 'running' | 'draining' | 'closed' | 'failed';
  createdAt: string;
  expiresAt: string;
  idleTimeoutMs: number | false;
  error?: string | undefined;
  connection?: SandboxConnection | undefined;
};

export type CreateSandboxOptions = {
  platform: 'ios' | 'android';
  ttlMs?: number;
  idleTimeoutMs?: number | false;
  wait?: boolean;
};

const DEFAULT_TIMEOUT_MS = 300_000;

export class CloudClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    const baseUrl = opts.baseUrl ?? process.env.PHONE_USE_CLOUD_URL ?? 'https://api.phoneuse.dev';
    const token = opts.token ?? process.env.PHONE_USE_CLOUD_TOKEN;
    if (!token) {
      throw new Error('Not signed in — run `phone-use login` (or set PHONE_USE_CLOUD_TOKEN)');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as T & {
      error?: string;
      code?: string;
    };
    if (!response.ok) {
      throw new CloudApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code);
    }
    return body;
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const { wait = true, ...input } = options;
    let sandbox = await this.request<Sandbox>('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!wait) return sandbox;
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (sandbox.status === 'queued' || sandbox.status === 'preparing') {
      if (Date.now() > deadline) throw new CloudApiError('timed out waiting for sandbox', 408);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      sandbox = await this.get(sandbox.id);
    }
    return sandbox;
  }

  list(): Promise<Sandbox[]> {
    return this.request('/v1/sandboxes');
  }

  get(id: string): Promise<Sandbox> {
    return this.request(`/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  async close(id: string, options: { wait?: boolean } = {}): Promise<Sandbox> {
    let sandbox = await this.request<Sandbox>(`/v1/sandboxes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (options.wait === false) return sandbox;
    const deadline = Date.now() + 60_000;
    while (sandbox.status === 'draining') {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      sandbox = await this.get(id);
    }
    return sandbox;
  }
}
