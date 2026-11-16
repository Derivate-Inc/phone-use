import { BaseDeviceBackend } from '../backend.ts';
import type {
  AlertAction,
  BackendAlertResult,
  Capability,
  OpenAppResult,
  PressTarget,
  ScrollDirection,
  Snapshot,
} from '../device.ts';
import { ActionFailedError, DeviceNotFoundError, TimeoutError } from '../errors.ts';

/**
 * A device-runner is addressed purely by URL, so it takes no DeviceConfig
 * platform/udid selection — only where to reach the runner and how to auth.
 */
export type DeviceRunnerConfig = {
  endpoint?: string | undefined;
  token?: string | undefined;
  timeoutMs?: number | undefined;
};

const RUNNER_CAPABILITIES: readonly Capability[] = [
  'snapshot',
  'screenshot',
  'press',
  'fill',
  'type',
  'scroll',
  'pan',
  'openApp',
  'home',
];

/**
 * Backend that speaks to an on-device runner: an XCTest-hosted JSON-RPC server
 * running ON the iPhone itself, which holds the automation privileges iOS
 * denies to ordinary apps.
 *
 * The endpoint is just a URL, so the same backend serves every topology:
 *   - `http://127.0.0.1:45678`  — port-forwarded from a paired host
 *   - `http://<phone-ip>:45678` — straight over the LAN / tailnet
 *   - `https://relay.example/d/<id>` — the runner dials out to a cloud relay,
 *     which is what lets an agent anywhere drive the phone with no inbound
 *     ports and no Mac in the loop.
 *
 * The wire format matches the shape proven by rounak/PhoneAgent: newline-free
 * JSON request/response over HTTP POST, one method per call.
 */
export class DeviceRunnerBackend extends BaseDeviceBackend {
  readonly #endpoint: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  constructor(config?: DeviceRunnerConfig) {
    // BaseDeviceBackend owns backendName/capabilities — set them via super()
    // rather than redeclaring the fields.
    super('device-runner', RUNNER_CAPABILITIES);
    const endpoint = config?.endpoint ?? process.env.PHONE_USE_RUNNER_URL ?? 'http://127.0.0.1:45678';
    this.#endpoint = endpoint.replace(/\/+$/, '');
    this.#token = config?.token ?? process.env.PHONE_USE_RUNNER_TOKEN;
    this.#timeoutMs = config?.timeoutMs ?? 30_000;
  }

  async #rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new TimeoutError(`runner did not answer ${method} within ${this.#timeoutMs}ms`);
      }
      throw new DeviceNotFoundError(
        `cannot reach the on-device runner at ${this.#endpoint} — is it activated on the phone?`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ActionFailedError(`runner returned HTTP ${res.status} for ${method}`);
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) {
      throw new ActionFailedError(body.error.message ?? `runner rejected ${method}`);
    }
    return body.result as T;
  }

  override async snapshot(opts?: {
    interactiveOnly?: boolean | undefined;
    depth?: number | undefined;
  }): Promise<Snapshot> {
    // The runner speaks its own compact wire shape; map it onto the SDK's
    // Snapshot contract so every consumer (CLI, MCP, agent, bench) is unaware
    // it is talking to a phone rather than a simulator.
    const wire = await this.#rpc<{
      app?: string;
      elements: Array<{
        ref: string;
        role?: string;
        label?: string;
        value?: string;
        enabled?: boolean;
        rect?: { x: number; y: number; w: number; h: number };
      }>;
    }>('get_tree', {
      interactiveOnly: opts?.interactiveOnly ?? false,
      depth: opts?.depth,
    });
    return {
      appBundleId: wire.app,
      appName: wire.app,
      nodes: (wire.elements ?? []).map((e) => ({
        ref: e.ref,
        role: e.role,
        type: e.role,
        label: e.label,
        value: e.value,
        enabled: e.enabled,
        rect: e.rect ? { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h } : undefined,
      })),
    };
  }

  override async screenshot(opts: {
    path: string;
    overlayRefs?: boolean | undefined;
  }): Promise<{ path: string }> {
    const { base64 } = await this.#rpc<{ base64: string }>('get_screen_image', {
      overlayRefs: opts.overlayRefs ?? false,
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.path, Buffer.from(base64, 'base64'));
    return { path: opts.path };
  }

  override async press(target: PressTarget): Promise<void> {
    // PressTarget is {ref} | {x,y} — never a bare string, so narrow on the key.
    if ('ref' in target) {
      await this.#rpc('tap_element', { ref: target.ref });
      return;
    }
    await this.#rpc('tap', { x: target.x, y: target.y });
  }

  override async fill(ref: string, text: string): Promise<void> {
    await this.#rpc('enter_text', { ref, text, replace: true });
  }

  override async typeText(text: string): Promise<void> {
    await this.#rpc('enter_text', { text, replace: false });
  }

  override async scroll(direction: ScrollDirection): Promise<void> {
    await this.#rpc('scroll', { direction });
  }

  override async pan(x: number, y: number, dx: number, dy: number, durationMs = 300): Promise<void> {
    await this.#rpc('swipe', { x, y, dx, dy, durationMs });
  }

  override async home(): Promise<void> {
    await this.#rpc('home');
  }

  override async openApp(opts: {
    app?: string | undefined;
    url?: string | undefined;
    relaunch?: boolean | undefined;
  }): Promise<OpenAppResult> {
    return this.#rpc<OpenAppResult>('open_app', {
      app: opts.app,
      url: opts.url,
      relaunch: opts.relaunch ?? false,
    });
  }

  override async systemAlert(action: AlertAction): Promise<BackendAlertResult> {
    return this.#rpc<BackendAlertResult>('alert', { action });
  }

  override async closeSession(): Promise<void> {
    // The runner outlives any single client; nothing to tear down.
  }

  /** Liveness probe used by `phone-use doctor` and the relay health check. */
  async ping(): Promise<{ ok: boolean; ios?: string; device?: string }> {
    return this.#rpc('get_context');
  }
}

/** Backend for a phone-runner reached by URL (defaults come from
 * `PHONE_USE_RUNNER_URL` / `PHONE_USE_RUNNER_TOKEN` when `config` is omitted). */
export const createDeviceRunnerBackend = (config?: DeviceRunnerConfig): DeviceRunnerBackend =>
  new DeviceRunnerBackend(config);
