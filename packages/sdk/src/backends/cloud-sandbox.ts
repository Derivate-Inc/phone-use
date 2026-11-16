import { writeFile } from 'node:fs/promises';
import { BaseDeviceBackend } from '../backend.ts';
import {
  ALL_CAPABILITIES,
  type AlertAction,
  type BackendAlertResult,
  type Capability,
  type OpenAppResult,
  type PressTarget,
  type ScrollDirection,
  type Snapshot,
} from '../device.ts';
import { PhoneUseError } from '../errors.ts';

// ---------------------------------------------------------------------------
// CloudSandboxBackend: drives a phone-use cloud sandbox (a simulator on a
// remote worker) over the worker's sandbox-scoped RPC endpoint. This is the
// client half of apps/api's worker protocol; it lives in the SDK so the
// CLI/MCP/agent can attach to a sandbox without depending on @phone-use/cloud
// (which also contains the server side and is not published).
//
// Wire protocol (shared with apps/api — keep in sync):
//   POST <endpoint>/rpc  {method, args}  ->  {ok:true,result} | {ok:false,error}
// ---------------------------------------------------------------------------

/** Every device verb a cloud sandbox accepts over the RPC wire. The worker's
 * runtime set is contract-tested against this union. */
export type SandboxRpcMethod =
  | 'viewerInput'
  | 'snapshot'
  | 'screenshot'
  | 'press'
  | 'longPress'
  | 'fill'
  | 'typeText'
  | 'pressKey'
  | 'scroll'
  | 'pan'
  | 'installApp'
  | 'waitForText'
  | 'systemAlert'
  | 'home'
  | 'back'
  | 'openApp'
  | 'listApps'
  | 'closeSession'
  | 'checkpoint'
  | 'restoreCheckpoint'
  | 'listCheckpoints'
  | 'deleteCheckpoint';

/** One saved device state, as reported by the worker. */
export type SandboxCheckpointInfo = {
  id: string;
  label?: string | undefined;
  createdAt: string;
};

/** Body of `POST <endpoint>/rpc`: one verb and its positional arguments. */
export type SandboxRpcRequest = { method: SandboxRpcMethod; args: unknown[] };
/** RPC completed; `result` is the verb-specific payload. */
export type SandboxRpcSuccess = { ok: true; result: unknown };
/** RPC failed on-device. `code` is a stable taxonomy bucket (`device_gone`,
 * `timeout`, `session_conflict`, `target_not_found`, `internal`) and
 * `retryable` tells agents whether retrying may succeed. */
export type SandboxRpcFailure = {
  ok: false;
  error: { message: string; code?: string | undefined; retryable?: boolean | undefined };
};
/** Discriminated RPC outcome — branch on `ok`. */
export type SandboxRpcResponse = SandboxRpcSuccess | SandboxRpcFailure;

/** Connection settings for one provisioned cloud phone: the per-sandbox
 * `endpoint`/`token` pair returned by `phone-use create` (or `/v1/sandboxes`). */
export type CloudSandboxBackendOptions = {
  endpoint: string;
  token: string;
  capabilities?: Capability[] | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

export class CloudSandboxBackend extends BaseDeviceBackend {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: CloudSandboxBackendOptions) {
    super('phone-use-cloud', opts.capabilities ?? ALL_CAPABILITIES);
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async rpc<T>(method: SandboxRpcMethod, ...args: unknown[]): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method, args } satisfies SandboxRpcRequest),
    });
    const body = (await response.json().catch(() => ({}))) as
      | SandboxRpcResponse
      | { error?: string; message?: string };
    if (!response.ok || !('ok' in body)) {
      const message =
        ('error' in body && typeof body.error === 'string' ? body.error : undefined) ??
        ('message' in body ? body.message : undefined) ??
        `HTTP ${response.status}`;
      throw new PhoneUseError(message, { code: 'UNKNOWN', retryable: false });
    }
    if (!body.ok) {
      throw new PhoneUseError(body.error.message, {
        code: normalizeErrorCode(body.error.code),
        retryable: body.error.retryable ?? false,
      });
    }
    return body.result as T;
  }

  override snapshot(opts?: { interactiveOnly?: boolean; depth?: number }): Promise<Snapshot> {
    return this.rpc('snapshot', opts);
  }

  override async screenshot(opts: { path: string; overlayRefs?: boolean }): Promise<{ path: string }> {
    const result = await this.rpc<{ base64: string }>('screenshot', {
      overlayRefs: opts.overlayRefs,
    });
    await writeFile(opts.path, Buffer.from(result.base64, 'base64'));
    return { path: opts.path };
  }

  override press(target: PressTarget): Promise<void> {
    return this.rpc('press', target);
  }
  override longPress(ref: string, durationMs?: number): Promise<void> {
    return this.rpc('longPress', ref, durationMs);
  }
  override fill(ref: string, text: string): Promise<void> {
    return this.rpc('fill', ref, text);
  }
  override typeText(text: string): Promise<void> {
    return this.rpc('typeText', text);
  }
  override pressKey(key: 'return'): Promise<void> {
    return this.rpc('pressKey', key);
  }
  override scroll(direction: ScrollDirection): Promise<void> {
    return this.rpc('scroll', direction);
  }
  override pan(x: number, y: number, dx: number, dy: number, durationMs?: number): Promise<void> {
    return this.rpc('pan', x, y, dx, dy, durationMs);
  }
  override waitForText(text: string, timeoutMs?: number): Promise<void> {
    return this.rpc('waitForText', text, timeoutMs);
  }
  override systemAlert(action: AlertAction): Promise<BackendAlertResult> {
    return this.rpc('systemAlert', action);
  }
  override home(): Promise<void> {
    return this.rpc('home');
  }
  override back(): Promise<void> {
    return this.rpc('back');
  }
  override openApp(opts: { app?: string; url?: string; relaunch?: boolean }): Promise<OpenAppResult> {
    return this.rpc('openApp', opts);
  }
  override listApps(): Promise<string[]> {
    return this.rpc('listApps');
  }
  override closeSession(): Promise<void> {
    return this.rpc('closeSession');
  }

  // -------------------------------------------------------------------------
  // Checkpoints: save/restore the WHOLE device state (apps, logins, photos,
  // settings). Not a UI snapshot — see `snapshot` for the accessibility tree.
  // The device is briefly unavailable while a checkpoint saves or restores
  // (shutdown → clone → boot on the worker); verbs issued meanwhile fail and
  // should be retried after the checkpoint call resolves.
  // -------------------------------------------------------------------------

  /** Save the device's current state. Returns the checkpoint's id. */
  checkpoint(opts?: { label?: string }): Promise<SandboxCheckpointInfo> {
    return this.rpc('checkpoint', opts);
  }

  /** Restore a checkpoint by id or label. The checkpoint survives — restore as
   * often as needed. Device identity may change server-side; the sandbox
   * endpoint/token stay valid. */
  restoreCheckpoint(ref: string): Promise<{ checkpointId: string }> {
    return this.rpc('restoreCheckpoint', ref);
  }

  /** List this sandbox's checkpoints. */
  listCheckpoints(): Promise<SandboxCheckpointInfo[]> {
    return this.rpc('listCheckpoints');
  }

  /** Delete a checkpoint by id or label. */
  deleteCheckpoint(ref: string): Promise<{ deleted: boolean }> {
    return this.rpc('deleteCheckpoint', ref);
  }

  /** Upload a zipped .app bundle (base64) and install it on the sandbox device. */
  /**
   * Upload a zipped .app as a raw stream. Prefer this over {@link installApp}:
   * base64 inside a JSON body inflates the payload by a third, which caps real
   * apps near 144MB. Pass a `Bun.file(...)` (or any Blob) and the bytes go to the
   * wire without being buffered in memory.
   */
  async installAppStream(zip: Blob): Promise<{ installed?: string }> {
    const response = await this.fetchImpl(`${this.endpoint}/app`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/zip',
      },
      body: zip,
    });
    // A worker older than this SDK has no /app route. Fall back to the base64
    // RPC rather than failing: a client should keep working against a fleet
    // that has not been redeployed yet. The old ceiling (~144MB of zip) still
    // applies on that path, and an app above it will say so.
    if (response.status === 404) {
      const bytes = await zip.arrayBuffer();
      return this.installApp(Buffer.from(bytes).toString('base64'));
    }
    const body = (await response.json().catch(() => ({}))) as SandboxRpcResponse | { error?: string };
    if (!response.ok || !('ok' in body)) {
      const message =
        ('error' in body && typeof body.error === 'string' ? body.error : undefined) ??
        `HTTP ${response.status}`;
      throw new PhoneUseError(message, { code: 'UNKNOWN', retryable: false });
    }
    if (!body.ok) {
      throw new PhoneUseError(body.error.message, {
        code: normalizeErrorCode(body.error.code),
        retryable: body.error.retryable ?? false,
      });
    }
    return body.result as { installed?: string };
  }

  /** @deprecated Base64-in-JSON; use {@link installAppStream}. */
  installApp(base64Zip: string): Promise<{ installed?: string }> {
    return this.rpc('installApp', base64Zip);
  }
}

/**
 * Build a CloudSandboxBackend from explicit options or the environment:
 * PHONE_USE_SANDBOX_URL + PHONE_USE_SANDBOX_TOKEN (printed by
 * `phone-use sandbox env <id>`).
 */
export function createCloudSandboxBackend(config?: Partial<CloudSandboxBackendOptions>): CloudSandboxBackend {
  const endpoint = config?.endpoint ?? process.env.PHONE_USE_SANDBOX_URL;
  const token = config?.token ?? process.env.PHONE_USE_SANDBOX_TOKEN;
  if (!endpoint || !token) {
    throw new PhoneUseError(
      'cloud sandbox backend needs PHONE_USE_SANDBOX_URL and PHONE_USE_SANDBOX_TOKEN (see `phone-use sandbox env <id>`)',
      { code: 'BACKEND_NOT_FOUND', retryable: false },
    );
  }
  return new CloudSandboxBackend({ ...config, endpoint, token });
}

function normalizeErrorCode(
  code: string | undefined,
):
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_IN_USE'
  | 'SESSION_NOT_FOUND'
  | 'TIMEOUT'
  | 'ACTION_FAILED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'BACKEND_NOT_FOUND'
  | 'ABORTED'
  | 'UNKNOWN' {
  const codes = new Set([
    'DEVICE_NOT_FOUND',
    'DEVICE_IN_USE',
    'SESSION_NOT_FOUND',
    'TIMEOUT',
    'ACTION_FAILED',
    'UNSUPPORTED_CAPABILITY',
    'BACKEND_NOT_FOUND',
    'ABORTED',
    'UNKNOWN',
  ]);
  if (codes.has(code ?? '')) return code as ReturnType<typeof normalizeErrorCode>;
  // The cloud worker's lowercase taxonomy (device_gone/timeout/…) maps into
  // the typed PhoneUseError codes instead of collapsing to UNKNOWN.
  const cloud: Record<string, ReturnType<typeof normalizeErrorCode>> = {
    device_gone: 'DEVICE_NOT_FOUND',
    sandbox_not_found: 'DEVICE_NOT_FOUND',
    timeout: 'TIMEOUT',
    session_conflict: 'DEVICE_IN_USE',
    target_not_found: 'ACTION_FAILED',
    unauthorized: 'ABORTED',
    payload_too_large: 'ACTION_FAILED',
    bad_request: 'ACTION_FAILED',
    internal: 'UNKNOWN',
  };
  return cloud[code ?? ''] ?? 'UNKNOWN';
}
