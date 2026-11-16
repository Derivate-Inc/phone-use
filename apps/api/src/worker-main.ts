#!/usr/bin/env bun
import { join } from 'node:path';
import { ensureRunner } from '@phone-use/sdk';
import { CaptureManager, captureCaPath } from './capture.ts';
import {
  AndroidCuttlefishProvider,
  AndroidEmulatorProvider,
  IosSimulatorProvider,
  type SandboxProvider,
  type WarmPoolHooks,
  WarmPoolProvider,
} from './providers.ts';
import type { ProvisionedResource, WorkerHost } from './types.ts';
import { MAX_APP_BYTES, platformFrom, SandboxWorker } from './worker.ts';
import { WorkerControlClient } from './worker-api.ts';
import { WorkerStateStore } from './worker-state.ts';

const controlUrl = process.env.PHONE_USE_CLOUD_URL;
const workerToken = process.env.PHONE_USE_CLOUD_WORKER_TOKEN;
const publicUrl = process.env.PHONE_USE_WORKER_PUBLIC_URL;
if (!controlUrl || !workerToken || !publicUrl) {
  console.error(
    'PHONE_USE_CLOUD_URL, PHONE_USE_CLOUD_WORKER_TOKEN, and PHONE_USE_WORKER_PUBLIC_URL are required',
  );
  process.exit(1);
}

const platform = platformFrom(process.env.PHONE_USE_WORKER_PLATFORM);
// iOS default from the measured M2-L (16 GB) density in docs/30: 11 slimmed
// sims boot clean, 12 degrades the host; 8 leaves headroom for boots under
// load. Halve it on an 8 GB M1-M. Android: ~2 GB per read-only instance.
const capacity = Number(process.env.PHONE_USE_WORKER_CAPACITY ?? (platform === 'ios' ? 8 : 4));
const hostId = process.env.PHONE_USE_WORKER_ID ?? `${platform}-${Bun.env.HOSTNAME ?? 'worker'}`;
const dataDirectory = process.env.PHONE_USE_WORKER_DATA ?? './data/worker';
const host: WorkerHost = {
  id: hostId,
  platform,
  capacity,
  publicUrl,
  metadata: {
    hostname: Bun.env.HOSTNAME,
    region: process.env.SCW_REGION,
    zone: process.env.SCW_ZONE,
  },
};

// Traffic capture is opt-in per host: mitmdump + attribution addon, with the
// mitm CA installed into every provisioned phone. See capture.ts for the
// operator-side proxy configuration a capture host also needs.
const capture = process.env.PHONE_USE_CAPTURE === '1' ? new CaptureManager({ dataDirectory }) : undefined;
if (capture) await capture.start();

// Android: headless emulator instances of one AVD by default (the path the
// AndroidWorld work runs on); PHONE_USE_ANDROID_PROVIDER=cuttlefish for cvd.
const androidProvider = process.env.PHONE_USE_ANDROID_PROVIDER ?? 'emulator';
let provider: SandboxProvider =
  platform === 'ios'
    ? new IosSimulatorProvider(capture ? { captureCaPath: captureCaPath() } : {})
    : androidProvider === 'cuttlefish'
      ? new AndroidCuttlefishProvider({ maxInstances: capacity })
      : new AndroidEmulatorProvider({ maxInstances: capacity });
const warmTarget = Number(process.env.PHONE_USE_WORKER_WARM_POOL ?? 1);
// Warm devices are real simulators and count against capacity when the control
// plane decides whether to dispatch (store.ts: active + reserved >= capacity).
// So the concurrency a tenant can actually reach is capacity MINUS the pool —
// a non-obvious subtraction that silently caps a fleet, and at warmTarget ===
// capacity wedges it completely: no job is ever dispatched.
const usable = capacity - warmTarget;
console.log(
  `capacity ${capacity} · warm pool ${warmTarget} · usable concurrency ${usable}`,
);
if (usable <= 0) {
  console.error(
    `FATAL: warm pool (${warmTarget}) leaves no usable capacity out of ${capacity}. ` +
      'Every create would queue forever. Lower PHONE_USE_WORKER_WARM_POOL or raise PHONE_USE_WORKER_CAPACITY.',
  );
  process.exit(1);
}

/**
 * An iOS phone's first action starts its phone-use XCTest runner, which takes
 * tens of seconds cold. Starting it in the pool moves that wait to before
 * handout. The sandbox's backend finds the same runner through the
 * per-simulator runner state, so nothing is started twice. Measured on one
 * simulator: warm-up 23 s, then the sandbox's first action 1 s on that runner.
 * Waiting phones are checked every keepWarmMs, and a runner that died is
 * started again. PHONE_USE_WARM_APP optionally preinstalls one .app on every
 * warm phone.
 */
function iosWarmHooks(): WarmPoolHooks {
  const startRunner = async ({ deviceId }: ProvisionedResource): Promise<void> => {
    await ensureRunner(deviceId);
  };
  const app = process.env.PHONE_USE_WARM_APP;
  return {
    warmUp: async (resource) => {
      if (app) {
        const install = Bun.spawn(['xcrun', 'simctl', 'install', resource.deviceId, app], {
          stdout: 'ignore',
          stderr: 'inherit',
        });
        if ((await install.exited) !== 0) throw new Error(`could not preinstall ${app}`);
      }
      await startRunner(resource);
    },
    keepWarm: startRunner,
    refillDelayMs: Number(process.env.PHONE_USE_WARM_REFILL_DELAY_MS ?? 0),
  };
}

if (warmTarget > 0) {
  const warm = new WarmPoolProvider(provider, warmTarget, platform === 'ios' ? iosWarmHooks() : {});
  warm.start();
  provider = warm;
}

const control = new WorkerControlClient(controlUrl, workerToken, hostId);
const worker = new SandboxWorker({
  host,
  control,
  provider,
  stateStore: new WorkerStateStore(join(dataDirectory, 'state.json')),
  dataDirectory,
  capture,
});

const server = Bun.serve({
  // App uploads stream to disk rather than buffering, so this only has to admit
  // the request — MAX_APP_BYTES is what actually bounds it.
  maxRequestBodySize: MAX_APP_BYTES + 16_000_000,
  hostname: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8090),
  fetch: (request, server) => worker.fetch(request, server),
  websocket: worker.websocket,
});
await worker.start();
console.log(`phone-use ${platform} worker ${hostId} listening on ${server.url}`);

async function shutdown(): Promise<void> {
  capture?.stop();
  await worker.stop();
  await server.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
