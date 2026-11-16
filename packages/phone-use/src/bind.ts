import { type Device, type DeviceBackend, ios } from '@phone-use/sdk';
import type { ExecRunner } from '@phone-use/sdk/testing';
import { DeviceContext } from './device-context.ts';
import { setDefaultDeviceContext } from './driver.ts';

// ---------------------------------------------------------------------------
// The harness rebind: bind the process's default device context to an
// EXPLICIT Device. With no spec the default backend drives the one booted
// simulator and refuses to guess when several are booted.
//
// The rebind is process-global (module-level driver facade): one device per
// process, last bind wins. handler(args, ctx) threading through the registry
// is deferred until multi-device MCP — at which point ctx must thread through
// task/explore/skills too, not just the 16 handlers.
// ---------------------------------------------------------------------------

/** Bind the harness to a caller-owned Device. Returns the shared context. */
export function bindDevice(device: Device): DeviceContext {
  const ctx = new DeviceContext(device.backend); // device.backend = lease-touching proxy
  setDefaultDeviceContext(ctx);
  return ctx;
}

export type SelectedDevice = { device: Device; owned: boolean; ctx: DeviceContext };

/**
 * Resolve a device spec (PHONE_USE_DEVICE / --device) to a bound Device:
 *   unset      → null: today's implicit behavior, untouched
 *   'launch'   → dedicated simulator, harness-owned (caller must close on exit)
 *   'connect'  → attach to the booted sim via simctl (explicit, Mac-only)
 *   <udid>     → attach to that simulator
 * Launched/connected devices get idleTimeoutMs:false — the server process's
 * lifetime is the lease; a mid-session reaper would delete the sim under the
 * MCP client between prompts.
 */
export async function selectDevice(
  spec: string | undefined = process.env.PHONE_USE_DEVICE,
  opts: { exec?: ExecRunner | undefined } = {},
): Promise<SelectedDevice | null> {
  if (!spec) return null;
  let shared: DeviceContext | null = null;
  const common = {
    idleTimeoutMs: false as const,
    coreFactory: (b: DeviceBackend) => {
      shared = new DeviceContext(b);
      return shared;
    },
    ...(opts.exec === undefined ? {} : { exec: opts.exec }),
  };
  const device =
    spec === 'launch'
      ? await ios.launch(common)
      : spec === 'connect'
        ? await ios.connect(undefined, common)
        : await ios.connect(spec, common);
  // The factory ran during launch/connect; shared is the SAME core the
  // device's verbs drive — one cache, literally.
  setDefaultDeviceContext(shared);
  return { device, owned: spec === 'launch', ctx: shared as unknown as DeviceContext };
}
