// Thin HTTP client for the Phone Use Cloud control plane — lives in the
// published CLI package so `phone-use create/list/env/close` work from npm.
// The server (and its richer client with device handles) stays in the private
// @phone-use/cloud workspace; wire shapes are shared by convention.

import { CLOUD_WAITLIST_CODE, CloudWaitlistError } from '@phone-use/sdk';

export class CloudApiError extends Error {
  readonly status: number;
  readonly code?: string | undefined;
  /** Sent with the `cloud_waitlist` refusal: where to join the waitlist. */
  readonly waitlistUrl?: string | undefined;

  constructor(message: string, status: number, code?: string, waitlistUrl?: string) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.code = code;
    this.waitlistUrl = waitlistUrl;
  }
}

/** Which surface is calling; sent as x-phone-use-client so refusals are counted by surface. */
export type CloudSurface = 'cli' | 'mcp';

const DEFAULT_API = 'https://api.phoneuse.dev';
const cloudBaseUrl = (baseUrl?: string): string =>
  (baseUrl ?? process.env.PHONE_USE_CLOUD_URL ?? DEFAULT_API).replace(/\/+$/, '');

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
  private readonly surface: CloudSurface;

  constructor(opts: { baseUrl?: string; token?: string; surface?: CloudSurface } = {}) {
    const token = opts.token ?? process.env.PHONE_USE_CLOUD_TOKEN;
    if (!token) {
      throw new Error('Not signed in — run `phone-use login` (or set PHONE_USE_CLOUD_TOKEN)');
    }
    this.baseUrl = cloudBaseUrl(opts.baseUrl);
    this.token = token;
    this.surface = opts.surface ?? 'cli';
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-phone-use-client': this.surface,
        ...(init?.headers ?? {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as T & {
      error?: string;
      code?: string;
      waitlistUrl?: string;
    };
    if (!response.ok) {
      throw new CloudApiError(
        body.error ?? `HTTP ${response.status}`,
        response.status,
        body.code,
        typeof body.waitlistUrl === 'string' ? body.waitlistUrl : undefined,
      );
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

/**
 * Create a cloud phone, for `phone-use create` and the MCP create tool.
 *
 * Cloud phones are on a waitlist. With no API key, or from an account that is
 * not approved, this throws CloudWaitlistError: its message tells a coding
 * agent that nothing was created, how to continue on this machine, and where
 * the user joins the waitlist. An approved account gets its phone as before.
 */
export async function createCloudPhone(
  options: CreateSandboxOptions & { surface: CloudSurface; baseUrl?: string },
): Promise<Sandbox> {
  const { surface, baseUrl, ...create } = options;
  if (!process.env.PHONE_USE_CLOUD_TOKEN) {
    await reportLoggedOutAttempt(cloudBaseUrl(baseUrl), create.platform, surface);
    throw new CloudWaitlistError({ surface, platform: create.platform, signedIn: false });
  }
  try {
    return await new CloudClient({ surface, ...(baseUrl ? { baseUrl } : {}) }).create(create);
  } catch (error) {
    if (error instanceof CloudApiError && error.code === CLOUD_WAITLIST_CODE) {
      throw new CloudWaitlistError(
        { surface, platform: create.platform, signedIn: true, waitlistUrl: error.waitlistUrl },
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * A create run while logged out never reaches POST /v1/sandboxes, so the
 * control plane is told here that someone asked for a cloud phone. It sends
 * the platform and the surface, nothing else, and is best-effort: offline or
 * slow, the caller still gets the waitlist message within three seconds.
 */
async function reportLoggedOutAttempt(
  baseUrl: string,
  platform: 'ios' | 'android',
  surface: CloudSurface,
): Promise<void> {
  await fetch(`${baseUrl}/v1/waitlist/attempts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, client: surface }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined);
}
