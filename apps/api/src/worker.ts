import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import {
  AndroidBackend,
  createXctestBackend,
  type DeviceBackend,
  type DevicePlatform,
  type Key,
  type PhoneUseError,
} from '@phone-use/sdk';
import { ViewerInputs } from './viewer-input.ts';
import { VideoStreams } from './video-stream.ts';
import { bearer, json } from './http.ts';
import type { CaptureManager } from './capture.ts';
import type { SandboxProvider } from './providers.ts';
import type {
  RpcMethod,
  RpcRequest,
  RpcResponse,
  SandboxCheckpoint,
  WorkerHost,
  WorkerJob,
} from './types.ts';
import type { WorkerControlClient } from './worker-api.ts';
import type { PersistedSandbox, WorkerStateStore } from './worker-state.ts';

type ActiveSandbox = PersistedSandbox & { backend: DeviceBackend };

/**
 * Reject after `ms`; if the underlying promise resolves AFTER the timeout, the
 * value is handed to `onLate` so a late-booting device is destroyed, not leaked.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onLate?: (value: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => {
        if (timedOut) onLate?.(value);
        return value;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ceiling for a streamed .app upload. Real iOS apps run well past the ~144MB the
 * old base64-in-JSON path allowed (Wikipedia's is 159MB zipped), so this is sized
 * for genuine production builds rather than sample apps.
 */
export const MAX_APP_BYTES = 1_073_741_824;

type StreamSocketData = { video?: boolean; deviceId: string; platform: DevicePlatform; sandboxId: string };
type StreamSocket = {
  data: StreamSocketData;
  readyState: number;
  send: (data: ArrayBuffer | Uint8Array) => void;
  getBufferedAmount?: () => number;
  close: () => void;
};

export type SandboxWorkerOptions = {
  host: WorkerHost;
  control: WorkerControlClient;
  provider: SandboxProvider;
  stateStore: WorkerStateStore;
  dataDirectory: string;
  pollIntervalMs?: number | undefined;
  backendFactory?: ((platform: DevicePlatform, deviceId: string) => DeviceBackend) | undefined;
  /** Per-phone traffic capture (opt-in per host). When present the worker
   * keeps its device→sandbox map current across provision/restore/delete. */
  capture?: CaptureManager | undefined;
  /** Ceiling for one provision (default PHONE_USE_PROVISION_TIMEOUT_MS or 8 min). */
  provisionTimeoutMs?: number | undefined;
};

export const RPC_METHODS = new Set<RpcMethod>([
  'viewerInput',
  'snapshot',
  'screenshot',
  'press',
  'longPress',
  'fill',
  'typeText',
  'pressKey',
  'scroll',
  'pan',
  'installApp',
  'waitForText',
  'systemAlert',
  'home',
  'back',
  'openApp',
  'listApps',
  'closeSession',
  'checkpoint',
  'restoreCheckpoint',
  'listCheckpoints',
  'deleteCheckpoint',
]);

export class SandboxWorker {
  private readonly viewerInputs = new ViewerInputs();
  private readonly active = new Map<string, ActiveSandbox>();
  private running = false;
  private heartbeat?: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: SandboxWorkerOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(this.opts.dataDirectory, { recursive: true, mode: 0o700 });
    for (const saved of await this.opts.stateStore.load()) {
      this.opts.provider.restore?.(saved.resource);
      this.active.set(saved.sandboxId, { ...saved, backend: this.backend(saved.resource.deviceId) });
      await this.opts.capture?.setDevice(saved.sandboxId, saved.resource.deviceId);
    }
    await this.opts.control.register(this.opts.host);
    await this.sweepOrphans();
    // Stale warm clones from a previous process die only after adoption has
    // protected the devices that belong to live sandboxes.
    await (this.opts.provider as { sweepStaleWarm?: () => Promise<void> }).sweepStaleWarm?.();
    this.heartbeat = setInterval(() => {
      const provider = this.opts.provider as { reserved?: number };
      void this.opts.control
        .heartbeat(typeof provider.reserved === 'number' ? provider.reserved : 0)
        .catch((error) => console.error('worker heartbeat failed:', error));
    }, 10_000);
    this.heartbeat.unref?.();
    this.running = true;
    void this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.videoStreams.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.persist();
  }

  async fetch(
    request: Request,
    server?: { upgrade: (request: Request, opts: { data: StreamSocketData }) => boolean },
  ): Promise<Response> {
    // Live view: authenticated H.264 video or legacy JPEG frames. Browsers cannot send an
    // Authorization header on WebSocket, so the sandbox token rides the query.
    const streamMatch = new URL(request.url).pathname.match(/^\/v1\/device\/([^/]+)\/(stream|video)$/);
    if (streamMatch && server) {
      const id = decodeURIComponent(streamMatch[1]!);
      const sandbox = this.active.get(id);
      const token = new URL(request.url).searchParams.get('token') ?? undefined;
      if (!sandbox || !safeEqual(token, sandbox.token)) return json({ error: 'unauthorized' }, 401);
      if (streamMatch[2] === 'video' && this.opts.host.platform !== 'ios')
        return json({ error: 'H.264 video is currently supported on iOS workers' }, 501);
      if (
        server.upgrade(request, {
          data: {
            video: streamMatch[2] === 'video',
            deviceId: sandbox.resource.deviceId,
            platform: this.opts.host.platform,
            sandboxId: id,
          },
        })
      ) {
        return new Response(null, { status: 101 });
      }
      return json({ error: 'websocket upgrade required' }, 400);
    }
    // Browsers call the device RPC directly (live view in the console), so the
    // worker answers preflights and stamps CORS; auth stays the sandbox token.
    const cors = {
      'access-control-allow-origin': request.headers.get('origin') ?? '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-credentials': 'true',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const response = await this.route(request);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  }

  /**
   * Unzip an already-on-disk .app bundle and install it on this sandbox's
   * simulator. Both upload paths land here; the zip arrives on disk rather than
   * in memory so a 300MB app costs a file, not a heap allocation.
   */
  private async installFromZip(
    sandbox: ActiveSandbox,
    work: string,
    zipPath: string,
  ): Promise<{ installed?: string | undefined }> {
    const unzip = Bun.spawn(['ditto', '-x', '-k', zipPath, work], { stderr: 'pipe' });
    if ((await unzip.exited) !== 0) {
      throw new Error(`unzip failed: ${await new Response(unzip.stderr).text()}`);
    }
    const appDir = (await Array.fromAsync(new Bun.Glob('**/*.app').scan({ cwd: work, onlyFiles: false })))
      .map((p) => join(work, p))
      .sort((a, b) => a.length - b.length)[0];
    if (!appDir) throw new Error('no .app bundle found in upload');
    const install = Bun.spawn(['xcrun', 'simctl', 'install', sandbox.resource.deviceId, appDir], {
      stderr: 'pipe',
    });
    if ((await install.exited) !== 0) {
      throw new Error(`simctl install failed: ${await new Response(install.stderr).text()}`);
    }
    return { installed: appDir.split('/').pop() };
  }

  /**
   * Raw-zip app upload. The body streams straight to disk, so memory stays flat
   * regardless of app size and the ceiling is a real byte count rather than the
   * base64-inflated one the JSON-RPC path is stuck with.
   */
  private async handleAppUpload(request: Request, sandbox: ActiveSandbox): Promise<Response> {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_APP_BYTES) return json({ error: 'app too large', code: 'payload_too_large' }, 413);
    const body = request.body;
    if (!body) return json({ error: 'empty app payload', code: 'bad_request' }, 400);

    const work = join(this.opts.dataDirectory, `install-${sandbox.sandboxId}-${Date.now()}`);
    await mkdir(work, { recursive: true });
    const zipPath = join(work, 'app.zip');
    try {
      const sink = Bun.file(zipPath).writer();
      let written = 0;
      // A ReadableStream is not reliably async-iterable across runtimes, so pull
      // it with an explicit reader.
      const reader = body.getReader();
      let oversize = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          // Count as we go: a content-length header is a claim, not a guarantee.
          written += value.byteLength;
          if (written > MAX_APP_BYTES) {
            oversize = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          sink.write(value);
        }
      } finally {
        await sink.end();
      }
      if (oversize) return json({ error: 'app too large', code: 'payload_too_large' }, 413);
      if (written === 0) return json({ error: 'empty app payload', code: 'bad_request' }, 400);

      const result = await this.installFromZip(sandbox, work, zipPath);
      void this.opts.control.touch(sandbox.sandboxId).catch(() => undefined);
      return json({ ok: true, result } satisfies RpcResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: { message } } satisfies RpcResponse, 500);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      const { warmReady } = this.opts.provider as { warmReady?: number };
      return json({
        ok: true,
        hostId: this.opts.host.id,
        active: this.active.size,
        warmReady,
        load: loadavg()[0],
      });
    }
    // Captured network flows for one sandbox (metadata by default; see
    // capture.ts). Same auth as every other per-sandbox surface: its token.
    const traffic = url.pathname.match(/^\/v1\/device\/([^/]+)\/traffic$/);
    if (traffic && request.method === 'GET') {
      const id = decodeURIComponent(traffic[1]!);
      const sandbox = this.active.get(id);
      if (!sandbox) return json({ error: 'sandbox not found', code: 'sandbox_not_found' }, 404);
      if (!safeEqual(bearer(request), sandbox.token))
        return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
      if (!this.opts.capture) {
        return json({ error: 'traffic capture is not enabled on this host', code: 'capture_disabled' }, 501);
      }
      const limit = Number(url.searchParams.get('limit') ?? 500);
      return json({ flows: await this.opts.capture.flowsFor(id, limit) });
    }
    const upload = url.pathname.match(/^\/v1\/device\/([^/]+)\/app$/);
    if (upload && request.method === 'POST') {
      const id = decodeURIComponent(upload[1]!);
      const sandbox = this.active.get(id);
      if (!sandbox) return json({ error: 'sandbox not found', code: 'sandbox_not_found' }, 404);
      if (!safeEqual(bearer(request), sandbox.token))
        return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
      return this.handleAppUpload(request, sandbox);
    }
    const match = url.pathname.match(/^\/v1\/device\/([^/]+)\/rpc$/);
    if (!match || request.method !== 'POST') return json({ error: 'not found', code: 'not_found' }, 404);
    const id = decodeURIComponent(match[1]!);
    const sandbox = this.active.get(id);
    if (!sandbox) return json({ error: 'sandbox not found', code: 'sandbox_not_found' }, 404);
    if (!safeEqual(bearer(request), sandbox.token))
      return json({ error: 'unauthorized', code: 'unauthorized' }, 401);

    // Reject oversized bodies BEFORE buffering/parsing them (codex #11).
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > 192_000_000)
      return json({ error: 'payload too large', code: 'payload_too_large' }, 413);
    let input: RpcRequest;
    try {
      input = (await request.json()) as RpcRequest;
    } catch {
      return json({ error: 'invalid JSON', code: 'bad_request' }, 400);
    }
    if (!RPC_METHODS.has(input.method) || !Array.isArray(input.args)) {
      return json({ error: 'invalid RPC method or arguments', code: 'bad_request' }, 400);
    }

    try {
      const result = await this.invoke(sandbox, input);
      void this.opts.control
        .touch(id, { method: input.method, detail: this.eventDetail(input) })
        .catch(() => undefined);
      return json({ ok: true, result } satisfies RpcResponse);
    } catch (error) {
      const typed = error as Partial<PhoneUseError>;
      const message = error instanceof Error ? error.message : String(error);
      return json(
        {
          ok: false,
          error: {
            message,
            code: typeof typed.code === 'string' ? typed.code : classifyRpcError(message),
            retryable: typeof typed.retryable === 'boolean' ? typed.retryable : isRetryableRpcError(message),
          },
        } satisfies RpcResponse,
        200,
      );
    }
  }

  /**
   * Live-view fan-out: capture runs ONCE per device regardless of viewer count
   * and every socket gets the same frames — N viewers cost the same as one.
   */
  private readonly videoStreams = new VideoStreams((id) => this.opts.control.touch(id));

  private readonly streamHubs = new Map<string, Set<StreamSocket>>();

  readonly websocket = {
    open: (ws: StreamSocket): void => {
      if (ws.data.video) {
        this.videoStreams.open(ws);
        return;
      }
      const existing = this.streamHubs.get(ws.data.deviceId);
      if (existing) {
        existing.add(ws);
        return;
      }
      const sockets = new Set<StreamSocket>([ws]);
      this.streamHubs.set(ws.data.deviceId, sockets);
      void this.streamFrames(ws.data, sockets);
    },
    message: (): void => {
      /* one-way stream */
    },
    close: (ws: StreamSocket): void => {
      if (ws.data.video) {
        this.videoStreams.close(ws);
        return;
      }
      this.streamHubs.get(ws.data.deviceId)?.delete(ws);
    },
  };

  /** Locate Meta's idb client if installed — the ~15-30fps capture path. */
  private idbBin(): string | undefined {
    if (process.env.PHONE_USE_IDB) return process.env.PHONE_USE_IDB;
    const home = process.env.HOME ?? '';
    for (const candidate of [`${home}/idb-venv/bin/idb`, '/opt/homebrew/bin/idb', '/usr/local/bin/idb']) {
      if (existsSync(candidate)) return candidate;
    }
    return Bun.which('idb') ?? undefined;
  }

  private async streamFrames(data: StreamSocketData, sockets: Set<StreamSocket>): Promise<void> {
    // Three staggered capture lanes (one capture ~110-130ms → ~3x frame rate),
    // sequence-guarded so the stream only moves forward. Watching counts as
    // activity — without the touch, the idle reaper kills a phone mid-view.
    const keepAlive = setInterval(() => {
      void this.opts.control.touch(data.sandboxId).catch(() => undefined);
    }, 30_000);
    void this.opts.control.touch(data.sandboxId).catch(() => undefined);
    const broadcast = (frame: ArrayBuffer): void => {
      for (const socket of sockets) if (socket.readyState === 1) socket.send(frame);
    };

    // Fast path (iOS): idb streams MJPEG straight off the framebuffer (~15-30fps).
    // Fallback below shells simctl per frame (~4-8fps). Same hub either way.
    const idb = data.platform === 'ios' ? this.idbBin() : undefined;
    let idbDelivered = false;
    if (idb) {
      const proc = Bun.spawn(
        [
          idb,
          'video-stream',
          '--udid',
          data.deviceId,
          '--format',
          'mjpeg',
          '--fps',
          '20',
          '--compression-quality',
          '0.4',
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const reader = proc.stdout.getReader();
      let pending = new Uint8Array(0);
      // Probe: idb's video-stream is broken against some runtimes (e.g. iOS 26
      // with companion 1.1.8). No frame within 4s → kill and use simctl.
      const probeTimer = setTimeout(() => {
        if (!idbDelivered) proc.kill();
      }, 4_000);
      try {
        while (sockets.size > 0) {
          const { done, value } = await reader.read();
          if (done) break;
          const merged = new Uint8Array(pending.length + value.length);
          merged.set(pending);
          merged.set(value, pending.length);
          pending = merged;
          // Split concatenated JPEGs on SOI/EOI markers (FF00 stuffing keeps
          // real FFD9 unambiguous inside entropy-coded data).
          let start = findMarker(pending, 0xd8, 0);
          while (start !== -1) {
            const end = findMarker(pending, 0xd9, start + 2);
            if (end === -1) break;
            const frame = pending.slice(start, end + 2);
            idbDelivered = true;
            broadcast(frame.buffer as ArrayBuffer);
            pending = pending.slice(end + 2);
            start = findMarker(pending, 0xd8, 0);
          }
          if (pending.length > 8_000_000) pending = new Uint8Array(0);
        }
      } catch {
        /* stream ended */
      } finally {
        clearTimeout(probeTimer);
        proc.kill();
      }
      if (idbDelivered || sockets.size === 0) {
        clearInterval(keepAlive);
        this.streamHubs.delete(data.deviceId);
        return;
      }
      // fall through: idb never produced a frame — simctl pipeline takes over
    }
    // Full-res sim frames are ~360KB of retina JPEG the browser must decode on
    // its main thread — the real fps ceiling. Downscale to 640px (~37KB) before
    // sending; the console renders at 240px anyway.
    let frameId = 0;
    // Android: `screencap -p` straight off adb as PNG. No host-side resize (no
    // sips on Linux); the browser sniffs the PNG magic and renders it fine.
    // ~150-300ms per capture on an emulator → 3-6fps through the same lanes.
    const captureAndroid = async (): Promise<ArrayBuffer> => {
      const shot = Bun.spawn(
        [process.env.PHONE_USE_ADB_BIN ?? 'adb', '-s', data.deviceId, 'exec-out', 'screencap', '-p'],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const [code, png] = await Promise.all([shot.exited, new Response(shot.stdout).arrayBuffer()]);
      return code === 0 ? png : new ArrayBuffer(0);
    };
    const captureIos = async (): Promise<ArrayBuffer> => {
      const tmp = join(this.opts.dataDirectory, `frame-${data.sandboxId}-${++frameId}.jpg`);
      try {
        const shot = Bun.spawn(['xcrun', 'simctl', 'io', data.deviceId, 'screenshot', '--type=jpeg', tmp], {
          stderr: 'ignore',
        });
        if ((await shot.exited) !== 0) return new ArrayBuffer(0);
        await Bun.spawn(['sips', '-Z', '640', tmp], { stdout: 'ignore', stderr: 'ignore' }).exited;
        return await Bun.file(tmp).arrayBuffer();
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    };
    const capture = data.platform === 'android' ? captureAndroid : captureIos;
    // Ordered pipeline, depth 3: captures overlap for throughput but frames are
    // consumed in start order — full overlap, zero dropped frames.
    const inflight: Promise<ArrayBuffer>[] = [];
    let failures = 0;
    while (sockets.size > 0) {
      while (inflight.length < 3) inflight.push(capture().catch(() => new ArrayBuffer(0)));
      const frame = await inflight.shift();
      if (frame && frame.byteLength > 0) {
        failures = 0;
        broadcast(frame);
      } else {
        // Dead device (reaped mid-view) must not become a process-spawn loop.
        failures += 1;
        if (failures >= 10) break;
        await Bun.sleep(500);
      }
    }
    clearInterval(keepAlive);
    this.streamHubs.delete(data.deviceId);
  }

  private inFlight = new Set<string>();

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        // Keep claiming while capacity allows: one cold 90s provision must not
        // serialize every other create — and never a delete — behind it.
        const capacity = this.opts.host.capacity;
        if (this.inFlight.size < capacity + 2) {
          const job = await this.opts.control.claim();
          if (job && !this.inFlight.has(job.sandbox.id)) {
            this.inFlight.add(job.sandbox.id);
            void this.runJob(job).finally(() => this.inFlight.delete(job.sandbox.id));
          }
        }
      } catch (error) {
        console.error('worker poll failed:', error);
      }
      await Bun.sleep(this.opts.pollIntervalMs ?? 750);
    }
  }

  private async runJob(job: WorkerJob): Promise<void> {
    if (job.kind === 'create') {
      let created: ActiveSandbox | undefined;
      try {
        // A provision that hangs (a wedged `simctl clone`, an emulator that
        // never boots) must not hold an inFlight slot forever while the host
        // heartbeats healthy; bound it below the control plane's 10-min reaper.
        const resource = await withTimeout(
          this.opts.provider.provision(job.sandbox),
          this.opts.provisionTimeoutMs ?? Number(process.env.PHONE_USE_PROVISION_TIMEOUT_MS ?? 480_000),
          `provision ${job.sandbox.id}`,
          (late) => void this.opts.provider.destroy(late).catch(() => undefined),
        );
        created = {
          sandboxId: job.sandbox.id,
          token: job.connectionToken,
          resource,
          backend: this.backend(resource.deviceId),
        };
        this.active.set(job.sandbox.id, created);
        await this.persist();
        await this.opts.capture?.setDevice(job.sandbox.id, resource.deviceId);
        await this.opts.control.completeCreate(job.sandbox.id, resource);
      } catch (error) {
        if (created) {
          await created.backend.closeSession().catch(() => undefined);
          await this.opts.provider.destroy(created.resource).catch(() => undefined);
          this.videoStreams.stopDevice(this.active.get(job.sandbox.id)?.resource.deviceId ?? '');
          this.active.delete(job.sandbox.id);
          await this.persist().catch(() => undefined);
        }
        await this.opts.control.fail(job.sandbox.id, error);
      }
    } else if (job.kind === 'delete') {
      try {
        const active = this.active.get(job.sandbox.id);
        if (active) {
          await active.backend.closeSession().catch(() => undefined);
          await this.destroyCheckpoints(active);
          await this.opts.provider.destroy(active.resource);
          this.videoStreams.stopDevice(this.active.get(job.sandbox.id)?.resource.deviceId ?? '');
          this.active.delete(job.sandbox.id);
          await this.opts.capture?.removeDevice(job.sandbox.id);
          await this.persist();
        }
        await this.opts.control.completeDelete(job.sandbox.id);
      } catch (error) {
        await this.opts.control.fail(job.sandbox.id, error);
      }
    }
  }

  /** Checkpoints die with their sandbox — they are shutdown clones nothing else
   * tracks, so any path that destroys the device must also destroy these or the
   * host slowly fills with unkillable disk. Best-effort per artifact: one
   * failed delete must not strand the rest. */
  private async destroyCheckpoints(sandbox: PersistedSandbox): Promise<void> {
    for (const checkpoint of sandbox.checkpoints ?? []) {
      await this.opts.provider.deleteCheckpoint?.(checkpoint.checkpointUdid).catch(() => undefined);
    }
  }

  /**
   * Destroy adopted devices the control plane no longer knows about. Without this
   * a worker that crashed while the plane reaped its sandboxes comes back holding
   * devices nobody will ever ask it to delete — the leak that costs real money.
   */
  private async sweepOrphans(): Promise<void> {
    if (this.active.size === 0) return;
    let live: Set<string>;
    try {
      live = new Set(await this.opts.control.liveSandboxIds());
    } catch (error) {
      console.error('orphan sweep skipped (control plane unreachable):', error);
      return;
    }
    for (const [id, sandbox] of [...this.active]) {
      if (live.has(id)) continue;
      console.warn(`worker: destroying orphaned device for ${id}`);
      await sandbox.backend.closeSession().catch(() => undefined);
      await this.destroyCheckpoints(sandbox);
      await this.opts.provider.destroy(sandbox.resource).catch(() => undefined);
      this.videoStreams.stopDevice(this.active.get(id)?.resource.deviceId ?? '');
      this.active.delete(id);
      await this.opts.capture?.removeDevice(id);
    }
    await this.persist().catch(() => undefined);
  }

  private backend(deviceId: string): DeviceBackend {
    if (this.opts.backendFactory) return this.opts.backendFactory(this.opts.host.platform, deviceId);
    return this.opts.host.platform === 'ios'
      ? // One phone-use XCTest runner per simulator, each on its own loopback
        // port, so concurrent sandboxes on a host never share a session.
        createXctestBackend({ udid: deviceId })
      : // The SDK's own adb backend — the one implementation the harness and
        // the AndroidWorld work ship on, not a second Android path.
        new AndroidBackend({ serial: deviceId, adbBin: process.env.PHONE_USE_ADB_BIN });
  }

  private async persist(): Promise<void> {
    await this.opts.stateStore.save(
      [...this.active.values()].map(({ sandboxId, token, resource, checkpoints }) => ({
        sandboxId,
        token,
        resource,
        ...(checkpoints === undefined ? {} : { checkpoints }),
      })),
    );
  }

  /**
   * One redacted line per verb for the action log. Typed text is NEVER
   * included — phones hold real logins — only its length. Labels/refs and app
   * names are what make a session readable ("press Sign in", "openApp Safari").
   */
  private eventDetail(request: RpcRequest): string | null {
    const a = request.args;
    const first = a[0] as Record<string, unknown> | string | undefined;
    const pick = (v: unknown) => (typeof v === 'string' ? v.slice(0, 120) : undefined);
    switch (request.method) {
      case 'press':
      case 'longPress': {
        const t = first as Record<string, unknown> | undefined;
        return JSON.stringify({ ref: pick(t?.ref), label: pick(t?.label), x: t?.x, y: t?.y });
      }
      case 'fill':
        return JSON.stringify({
          ref: pick((first as Record<string, unknown>)?.ref),
          textLength: String((a[1] as string) ?? '').length,
        });
      case 'typeText':
        return JSON.stringify({ textLength: String((first as string) ?? '').length });
      case 'pressKey':
      case 'scroll':
        return JSON.stringify({ arg: pick(typeof first === 'string' ? first : JSON.stringify(first)) });
      case 'openApp':
        return JSON.stringify({
          app: pick((first as Record<string, unknown>)?.app),
          url: pick((first as Record<string, unknown>)?.url),
        });
      case 'waitForText':
        return JSON.stringify({ text: pick(first as string) });
      case 'checkpoint':
        return JSON.stringify({ label: pick((first as Record<string, unknown>)?.label) });
      case 'restoreCheckpoint':
      case 'deleteCheckpoint':
        return JSON.stringify({ checkpoint: pick(first as string) });
      default:
        return null;
    }
  }

  /**
   * Save the sandbox's device state as a reusable checkpoint. The daemon
   * session closes first (the device reboots underneath it; a stale bound
   * session poisons every verb after wake) and the backend is rebuilt after —
   * same udid, fresh session.
   */
  private async saveCheckpoint(sandbox: ActiveSandbox, label?: string): Promise<SandboxCheckpoint> {
    if (!this.opts.provider.checkpoint) throw new Error('checkpoints are not supported on this host');
    const id = `ckpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await sandbox.backend.closeSession().catch(() => undefined);
    const { checkpointUdid } = await this.opts.provider.checkpoint(
      sandbox.resource,
      `phone-use-ckpt-${sandbox.sandboxId}-${id}`,
    );
    sandbox.backend = this.backend(sandbox.resource.deviceId);
    const checkpoint: SandboxCheckpoint = {
      id,
      checkpointUdid,
      ...(label === undefined ? {} : { label }),
      createdAt: new Date().toISOString(),
    };
    sandbox.checkpoints = [...(sandbox.checkpoints ?? []), checkpoint];
    await this.persist();
    return checkpoint;
  }

  /**
   * Swap the sandbox's device for a clone of a checkpoint. The device identity
   * CHANGES (simctl cannot clone onto an existing udid): resource and backend
   * are rebound here, and persistence happens before returning so a worker
   * crash right after the swap still knows which device it owns. Clients are
   * untouched — the RPC path is keyed by sandbox id, not device id. A live
   * stream keyed on the old device dies with it; viewers reconnect.
   */
  private async restoreFromCheckpoint(
    sandbox: ActiveSandbox,
    checkpointRef: string,
  ): Promise<{ checkpointId: string; deviceId: string }> {
    if (!this.opts.provider.restoreCheckpoint) {
      throw new Error('checkpoints are not supported on this host');
    }
    const checkpoint = (sandbox.checkpoints ?? []).find(
      (c) => c.id === checkpointRef || c.checkpointUdid === checkpointRef || c.label === checkpointRef,
    );
    if (!checkpoint) throw new Error(`no checkpoint "${checkpointRef}" on this sandbox`);
    await sandbox.backend.closeSession().catch(() => undefined);
    const restored = await this.opts.provider.restoreCheckpoint(
      sandbox.resource,
      checkpoint.checkpointUdid,
      `phone-use-cloud-${sandbox.sandboxId}`,
    );
    this.videoStreams.stopDevice(sandbox.resource.deviceId);
    sandbox.resource = restored;
    sandbox.backend = this.backend(restored.deviceId);
    await this.persist();
    // Re-point traffic attribution at the new udid, or every flow after a
    // restore silently becomes unattributed.
    await this.opts.capture?.setDevice(sandbox.sandboxId, restored.deviceId);
    return { checkpointId: checkpoint.id, deviceId: restored.deviceId };
  }

  private async dropCheckpoint(sandbox: ActiveSandbox, checkpointRef: string): Promise<{ deleted: boolean }> {
    const checkpoint = (sandbox.checkpoints ?? []).find(
      (c) => c.id === checkpointRef || c.checkpointUdid === checkpointRef || c.label === checkpointRef,
    );
    if (!checkpoint) return { deleted: false };
    await this.opts.provider.deleteCheckpoint?.(checkpoint.checkpointUdid);
    sandbox.checkpoints = (sandbox.checkpoints ?? []).filter((c) => c.id !== checkpoint.id);
    await this.persist();
    return { deleted: true };
  }

  private async invoke(sandbox: ActiveSandbox, request: RpcRequest): Promise<unknown> {
    const backend = sandbox.backend;
    const args = request.args;
    switch (request.method) {
      case 'checkpoint':
        return this.saveCheckpoint(sandbox, (args[0] as { label?: string } | undefined)?.label ?? undefined);
      case 'restoreCheckpoint':
        return this.restoreFromCheckpoint(sandbox, String(args[0] ?? ''));
      case 'listCheckpoints':
        return (sandbox.checkpoints ?? []).map(({ id, label, createdAt }) => ({
          id,
          label,
          createdAt,
        }));
      case 'deleteCheckpoint':
        return this.dropCheckpoint(sandbox, String(args[0] ?? ''));
      case 'viewerInput': {
        if (this.opts.host.platform !== 'ios') throw new Error('Viewer gestures currently require iOS');
        return this.viewerInputs.send(sandbox.resource.deviceId, args[0]);
      }
      case 'snapshot':
        return backend.snapshot(args[0] as Parameters<DeviceBackend['snapshot']>[0]);
      case 'screenshot': {
        const path = join(this.opts.dataDirectory, `screenshot-${sandbox.sandboxId}-${Date.now()}.png`);
        try {
          await backend.screenshot({
            path,
            overlayRefs: (args[0] as { overlayRefs?: boolean } | undefined)?.overlayRefs,
          });
          return { base64: (await readFile(path)).toString('base64') };
        } finally {
          await rm(path, { force: true }).catch(() => undefined);
        }
      }
      case 'press':
        return backend.press(args[0] as Parameters<DeviceBackend['press']>[0]);
      case 'longPress':
        return backend.longPress(args[0] as string, args[1] == null ? undefined : (args[1] as number));
      case 'fill':
        return backend.fill(args[0] as string, args[1] as string);
      case 'typeText':
        return backend.typeText(args[0] as string);
      case 'pressKey':
        return backend.pressKey(args[0] as Key);
      case 'scroll':
        return backend.scroll(args[0] as Parameters<DeviceBackend['scroll']>[0]);
      case 'pan':
        return backend.pan(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] == null ? undefined : (args[4] as number),
        );
      // Device operation, not a UI verb. Kept for older clients: the payload is a
      // base64 zip carried inside the JSON body, which inflates it by a third and
      // caps the real app size near 144MB. New clients POST the raw zip to
      // /v1/device/:id/app instead — see handleAppUpload.
      case 'installApp': {
        const base64 = args[0] as string;
        if (typeof base64 !== 'string' || base64.length === 0) throw new Error('empty app payload');
        if (base64.length > 180_000_000) throw new Error('app payload too large (>128MB)');
        if (!/^[A-Za-z0-9+/=]+$/.test(base64.slice(0, 4096))) throw new Error('payload is not base64');
        const work = join(this.opts.dataDirectory, `install-${sandbox.sandboxId}-${Date.now()}`);
        await mkdir(work, { recursive: true });
        try {
          const zipPath = join(work, 'app.zip');
          await Bun.write(zipPath, Buffer.from(base64, 'base64'));
          return await this.installFromZip(sandbox, work, zipPath);
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      case 'waitForText':
        return backend.waitForText(args[0] as string, args[1] == null ? undefined : (args[1] as number));
      case 'systemAlert':
        return backend.systemAlert(args[0] as Parameters<DeviceBackend['systemAlert']>[0]);
      case 'home':
        return backend.home();
      case 'back':
        return backend.back();
      case 'openApp':
        return backend.openApp(args[0] as Parameters<DeviceBackend['openApp']>[0]);
      case 'listApps':
        return backend.listApps();
      case 'closeSession':
        return backend.closeSession();
    }
  }
}

function findMarker(buffer: Uint8Array, second: number, from: number): number {
  for (let i = from; i < buffer.length - 1; i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === second) return i;
  }
  return -1;
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function platformFrom(value: string | undefined): DevicePlatform {
  if (value === 'ios' || value === 'android') return value;
  throw new Error('PHONE_USE_WORKER_PLATFORM must be ios or android');
}

/** Fallback taxonomy for driver errors that don't carry a typed code. Message
 * sniffing is inherently best-effort; a wrong bucket still beats no bucket
 * because agents branch on retryable, and 'internal' is the safe default. */
export function classifyRpcError(message: string): string {
  if (/invalid device|no such device|not booted|device.*(gone|offline)/i.test(message)) return 'device_gone';
  if (/timed?[\s-]?out|deadline/i.test(message)) return 'timeout';
  if (/session .*(bound|busy)|already (bound|running)/i.test(message)) return 'session_conflict';
  if (/not found|no element|no match/i.test(message)) return 'target_not_found';
  return 'internal';
}

export function isRetryableRpcError(message: string): boolean {
  const code = classifyRpcError(message);
  return code === 'timeout' || code === 'session_conflict';
}
