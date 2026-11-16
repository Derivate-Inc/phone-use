import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { android, type Device, type DevicePlatform } from '@phone-use/sdk';
import type { ProvisionedResource, Sandbox } from './types.ts';

export interface SandboxProvider {
  readonly platform: DevicePlatform;
  provision(sandbox: Pick<Sandbox, 'id' | 'platform'>): Promise<ProvisionedResource>;
  destroy(resource: ProvisionedResource): Promise<void>;
  restore?(resource: ProvisionedResource): void;
  /**
   * Wipe all tenant state from a device that is about to be handed to someone
   * else. Providers that destroy the device on release may no-op, but anything
   * that RECYCLES a device (warm pools) must implement this — otherwise one
   * tenant's accounts, keychain and photos reach the next one.
   */
  reset?(resource: ProvisionedResource): Promise<void>;
  /**
   * Save the device's current state as a reusable checkpoint. Returns the id of
   * the checkpoint artifact (for simulators: the udid of a shutdown clone). The
   * live device is running again by the time this resolves.
   */
  checkpoint?(resource: ProvisionedResource, name: string): Promise<{ checkpointUdid: string }>;
  /**
   * Replace the device's state with a checkpoint's. Returns the NEW resource —
   * restore may change the device identity (simctl cannot clone onto an
   * existing udid), and the caller must rebind anything keyed on deviceId.
   * The checkpoint itself survives: restore clones it, never consumes it.
   */
  restoreCheckpoint?(
    resource: ProvisionedResource,
    checkpointUdid: string,
    name: string,
  ): Promise<ProvisionedResource>;
  /** Delete a checkpoint artifact. Idempotent — a missing artifact is success. */
  deleteCheckpoint?(checkpointUdid: string): Promise<void>;
}

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined>; cwd?: string | undefined },
) => Promise<CommandResult>;

const runCommand: CommandRunner = async (command, args, opts = {}) => {
  const process = Bun.spawn([command, ...args], {
    env: { ...Bun.env, ...opts.env },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr };
};

export type IosProviderOptions = {
  goldenUdid?: string | undefined;
  deviceType?: string | undefined;
  runtime?: string | undefined;
  exec?: CommandRunner | undefined;
  bootTimeoutMs?: number | undefined;
  /**
   * PEM CA to trust on every provisioned phone (traffic capture). Installed
   * post-boot via `simctl keychain add-root-cert`; a failure fails the
   * provision — an operator who configured capture must not get phones whose
   * traffic silently can't be decrypted. Checkpoint clones inherit the
   * keychain, so restores need no re-install.
   */
  captureCaPath?: string | undefined;
};

export class IosSimulatorProvider implements SandboxProvider {
  readonly platform = 'ios' as const;

  /**
   * simctl cannot clone one source concurrently: parallel clones race on the
   * golden and the loser reports `current state: Booted` for a device that is
   * demonstrably Shutdown. Seen live — three phones cloning at once degraded a
   * 3/3 run to 0/3 once host load widened the window. Serialising also flattens
   * the load spike of N simultaneous clones, which is what saturated the host.
   */
  private static cloneChain: Promise<unknown> = Promise.resolve();

  private static serialiseClone<T>(fn: () => Promise<T>): Promise<T> {
    const run = IosSimulatorProvider.cloneChain.then(fn, fn);
    IosSimulatorProvider.cloneChain = run.catch(() => undefined);
    return run;
  }

  private readonly exec: CommandRunner;
  private readonly bootTimeoutMs: number;

  constructor(private readonly opts: IosProviderOptions = {}) {
    this.exec = opts.exec ?? runCommand;
    this.bootTimeoutMs = opts.bootTimeoutMs ?? Number(process.env.PHONE_USE_BOOT_TIMEOUT_MS ?? 90_000);
  }

  async provision(sandbox: Pick<Sandbox, 'id'>): Promise<ProvisionedResource> {
    const name = `phone-use-cloud-${sandbox.id}`;
    const goldenUdid = this.opts.goldenUdid ?? process.env.PHONE_USE_IOS_GOLDEN_UDID;
    let result: CommandResult;
    if (goldenUdid) {
      // simctl refuses to clone a booted device (SimError 405). Cloning is the
      // fast path — the clone inherits the golden's already-migrated state, so
      // its boot skips the ~17s first-boot migration that a fresh erase re-pays.
      const clone = () => this.exec('xcrun', ['simctl', 'clone', goldenUdid, name]);
      try {
        result = await IosSimulatorProvider.serialiseClone(clone);
      } catch (error) {
        if (!/current state: Booted/i.test(String(error))) throw error;
        // The golden really can be left booted (a stray `simctl boot`), but far
        // more often this is the clone race above. Distinguish by asking simctl,
        // so an operator never gets sent to shut down a device that is Shutdown.
        const listed = await this.exec('xcrun', ['simctl', 'list', 'devices', goldenUdid]).catch(
          () => undefined,
        );
        if (listed && /Booted/i.test(listed.stdout)) {
          throw new Error(
            `golden simulator ${goldenUdid} is booted; shut it down — clone requires a shutdown source`,
          );
        }
        await Bun.sleep(2_000);
        result = await IosSimulatorProvider.serialiseClone(clone);
      }
    } else {
      const deviceType =
        this.opts.deviceType ??
        process.env.PHONE_USE_IOS_DEVICE_TYPE ??
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
      const runtime =
        this.opts.runtime ??
        process.env.PHONE_USE_IOS_RUNTIME ??
        'com.apple.CoreSimulator.SimRuntime.iOS-26-2';
      result = await this.exec('xcrun', ['simctl', 'create', name, deviceType, runtime]);
    }
    const deviceId =
      result.stdout.match(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/i)?.[0] ?? result.stdout.trim();
    if (!deviceId) throw new Error('simctl did not return a simulator UDID');
    try {
      await this.exec('xcrun', ['simctl', 'boot', deviceId]);
      // Never wait unbounded on bootstatus: simulators hang in 'Booting' often
      // enough that an unbounded wait silently wedges a worker slot.
      await withTimeout(
        this.exec('xcrun', ['simctl', 'bootstatus', deviceId, '-b']),
        this.bootTimeoutMs,
        `simulator ${deviceId} did not finish booting in ${this.bootTimeoutMs}ms`,
      );
      if (this.opts.captureCaPath) {
        await this.exec('xcrun', ['simctl', 'keychain', deviceId, 'add-root-cert', this.opts.captureCaPath]);
      }
      return { deviceId, name };
    } catch (error) {
      await this.exec('xcrun', ['simctl', 'delete', deviceId]).catch(() => undefined);
      throw error;
    }
  }

  async destroy(resource: ProvisionedResource): Promise<void> {
    await this.exec('xcrun', ['simctl', 'shutdown', resource.deviceId]).catch(() => undefined);
    try {
      await this.exec('xcrun', ['simctl', 'delete', resource.deviceId]);
    } catch (error) {
      // Idempotent: a device that no longer exists is a successful destroy —
      // otherwise a sandbox whose sim vanished drains forever.
      if (!/invalid device|not found/i.test(String(error))) throw error;
    }
  }

  /**
   * Checkpoint = shutdown → clone → boot again. The clone (never booted, so
   * always a valid clone SOURCE later) IS the checkpoint; on APFS the copy is
   * copy-on-write, so a checkpoint costs only the blocks that later diverge.
   * The finally-boot matters: whatever cloning did, the session's device must
   * come back up — a failed checkpoint must not leave a dead phone behind.
   */
  async checkpoint(resource: ProvisionedResource, name: string): Promise<{ checkpointUdid: string }> {
    await this.exec('xcrun', ['simctl', 'shutdown', resource.deviceId]).catch(() => undefined);
    try {
      const result = await IosSimulatorProvider.serialiseClone(() =>
        this.exec('xcrun', ['simctl', 'clone', resource.deviceId, name]),
      );
      const checkpointUdid = extractUdid(result.stdout);
      if (!checkpointUdid) throw new Error('simctl clone did not return a checkpoint UDID');
      return { checkpointUdid };
    } finally {
      await this.exec('xcrun', ['simctl', 'boot', resource.deviceId]).catch(() => undefined);
      await withTimeout(
        this.exec('xcrun', ['simctl', 'bootstatus', resource.deviceId, '-b']),
        this.bootTimeoutMs,
        `simulator ${resource.deviceId} did not finish booting after checkpoint`,
      ).catch(() => undefined);
    }
  }

  /**
   * Restore = clone the checkpoint → boot the clone → only then delete the old
   * device. Ordered so a failed restore (clone error, boot hang) leaves the
   * session's current device intact and rebootable instead of gone. Returns the
   * clone as the new resource — the udid changes, callers must rebind.
   */
  async restoreCheckpoint(
    resource: ProvisionedResource,
    checkpointUdid: string,
    name: string,
  ): Promise<ProvisionedResource> {
    const result = await IosSimulatorProvider.serialiseClone(() =>
      this.exec('xcrun', ['simctl', 'clone', checkpointUdid, name]),
    );
    const deviceId = extractUdid(result.stdout);
    if (!deviceId) throw new Error('simctl clone did not return a device UDID');
    try {
      await this.exec('xcrun', ['simctl', 'boot', deviceId]);
      await withTimeout(
        this.exec('xcrun', ['simctl', 'bootstatus', deviceId, '-b']),
        this.bootTimeoutMs,
        `restored simulator ${deviceId} did not finish booting in ${this.bootTimeoutMs}ms`,
      );
    } catch (error) {
      await this.exec('xcrun', ['simctl', 'delete', deviceId]).catch(() => undefined);
      throw error;
    }
    await this.exec('xcrun', ['simctl', 'shutdown', resource.deviceId]).catch(() => undefined);
    await this.exec('xcrun', ['simctl', 'delete', resource.deviceId]).catch(() => undefined);
    return { deviceId, name };
  }

  async deleteCheckpoint(checkpointUdid: string): Promise<void> {
    try {
      await this.exec('xcrun', ['simctl', 'delete', checkpointUdid]);
    } catch (error) {
      if (!/invalid device|not found/i.test(String(error))) throw error;
    }
  }

  /**
   * `simctl erase` restores the device to factory contents — apps, keychain,
   * photos, Safari data, everything. It requires the device to be shut down, so
   * the sequence is shutdown → erase → boot, and we wait for a real boot before
   * declaring the device usable again.
   */
  async reset(resource: ProvisionedResource): Promise<void> {
    await this.exec('xcrun', ['simctl', 'shutdown', resource.deviceId]).catch(() => undefined);
    await this.exec('xcrun', ['simctl', 'erase', resource.deviceId]);
    // Simulator.app syncs the HOST pasteboard into every device, and erase does
    // not touch it — so a copied secret outlives the wipe and reaches the next
    // tenant. Clear it explicitly.
    await this.exec('pbcopy', []).catch(() => undefined);
    await this.exec('xcrun', ['simctl', 'boot', resource.deviceId]);
    await withTimeout(
      this.exec('xcrun', ['simctl', 'bootstatus', resource.deviceId, '-b']),
      this.bootTimeoutMs,
      `simulator ${resource.deviceId} did not finish booting after erase`,
    );
  }
}

export type AndroidProviderOptions = {
  root?: string | undefined;
  artifacts?: string | undefined;
  baseInstance?: number | undefined;
  maxInstances?: number | undefined;
  exec?: CommandRunner | undefined;
};

export class AndroidCuttlefishProvider implements SandboxProvider {
  readonly platform = 'android' as const;
  private readonly exec: CommandRunner;
  private readonly root: string;
  private readonly artifacts: string;
  private readonly baseInstance: number;
  private readonly maxInstances: number;
  private readonly allocated = new Set<number>();

  constructor(opts: AndroidProviderOptions = {}) {
    this.exec = opts.exec ?? runCommand;
    this.root = opts.root ?? process.env.PHONE_USE_ANDROID_ROOT ?? '/var/lib/phone-use/cuttlefish';
    this.artifacts = opts.artifacts ?? process.env.PHONE_USE_ANDROID_ARTIFACTS ?? '';
    this.baseInstance = opts.baseInstance ?? Number(process.env.PHONE_USE_ANDROID_BASE_INSTANCE ?? 1);
    this.maxInstances = opts.maxInstances ?? Number(process.env.PHONE_USE_WORKER_CAPACITY ?? 4);
  }

  async provision(sandbox: Pick<Sandbox, 'id'>): Promise<ProvisionedResource> {
    if (!this.artifacts) {
      throw new Error('PHONE_USE_ANDROID_ARTIFACTS must point to an extracted Cuttlefish image directory');
    }
    const instance = this.takeInstance();
    const home = join(this.root, sandbox.id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const serial = this.serialFor(instance);
    try {
      await this.exec(
        process.env.PHONE_USE_CVD_BIN ?? 'cvd',
        [
          'create',
          '--daemon',
          `--base_instance_num=${instance}`,
          '--num_instances=1',
          `--gpu_mode=${process.env.PHONE_USE_ANDROID_GPU_MODE ?? 'guest_swiftshader'}`,
          '--report_anonymous_usage_stats=n',
        ],
        { env: { HOME: home }, cwd: this.artifacts },
      );
      await this.exec(process.env.PHONE_USE_ADB_BIN ?? 'adb', ['-s', serial, 'wait-for-device']);
      await this.waitForBoot(serial);
      return {
        deviceId: serial,
        name: `Cuttlefish ${instance}`,
        metadata: { instance, home },
      };
    } catch (error) {
      this.allocated.delete(instance);
      await this.exec(process.env.PHONE_USE_CVD_BIN ?? 'cvd', ['stop'], { env: { HOME: home } }).catch(
        () => undefined,
      );
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  }

  async destroy(resource: ProvisionedResource): Promise<void> {
    const instance = Number(resource.metadata?.instance);
    const home = String(resource.metadata?.home ?? '');
    if (!home.startsWith(`${this.root}/`))
      throw new Error(`refusing to remove unexpected Cuttlefish home: ${home}`);
    await this.exec(process.env.PHONE_USE_CVD_BIN ?? 'cvd', ['stop'], { env: { HOME: home } }).catch(
      () => undefined,
    );
    await rm(home, { recursive: true, force: true });
    if (Number.isInteger(instance)) this.allocated.delete(instance);
  }

  restore(resource: ProvisionedResource): void {
    const instance = Number(resource.metadata?.instance);
    if (Number.isInteger(instance)) this.allocated.add(instance);
  }

  private takeInstance(): number {
    for (let offset = 0; offset < this.maxInstances; offset += 1) {
      const instance = this.baseInstance + offset;
      if (!this.allocated.has(instance)) {
        this.allocated.add(instance);
        return instance;
      }
    }
    throw new Error(`Cuttlefish capacity exhausted (${this.maxInstances})`);
  }

  private serialFor(instance: number): string {
    const template = process.env.PHONE_USE_ANDROID_SERIAL_TEMPLATE ?? '127.0.0.1:{port}';
    const port = 6520 + instance - 1;
    return template.replace('{instance}', String(instance)).replace('{port}', String(port));
  }

  private async waitForBoot(serial: string): Promise<void> {
    const deadline = Date.now() + Number(process.env.PHONE_USE_ANDROID_BOOT_TIMEOUT_MS ?? 180_000);
    while (Date.now() < deadline) {
      const result = await this.exec(process.env.PHONE_USE_ADB_BIN ?? 'adb', [
        '-s',
        serial,
        'shell',
        'getprop',
        'sys.boot_completed',
      ]);
      if (result.stdout.trim() === '1') return;
      await Bun.sleep(1_000);
    }
    throw new Error(`timed out waiting for Android ${serial} to boot`);
  }
}

export type AndroidEmulatorProviderOptions = {
  /** AVD name to boot instances from (default PHONE_USE_ANDROID_AVD). */
  avd?: string | undefined;
  /** Path to the emulator binary (default $ANDROID_HOME/emulator/emulator). */
  emulatorBin?: string | undefined;
  /** Path to adb (default PHONE_USE_ADB_BIN or `adb`). */
  adbBin?: string | undefined;
  /** First console port; instance N uses basePort + 2N (default 5554). */
  basePort?: number | undefined;
  maxInstances?: number | undefined;
  /** Extra emulator flags (default PHONE_USE_ANDROID_EMULATOR_ARGS, whitespace-split). */
  extraArgs?: string[] | undefined;
  bootTimeoutMs?: number | undefined;
  /** @internal test seam. */
  launch?: typeof android.launch | undefined;
  /** @internal test seam. */
  exec?: CommandRunner | undefined;
};

/**
 * Android sandboxes as headless emulator instances of ONE golden AVD. Every
 * instance runs `-read-only`, so N phones share the system image and each
 * tenant's userdata is discarded on kill — reset is free and there is nothing
 * to wipe. Needs /dev/kvm; the AVD must have been booted once normally so its
 * quick-boot snapshot exists (deploy/scaleway/bootstrap-android-host.sh).
 */
export class AndroidEmulatorProvider implements SandboxProvider {
  readonly platform = 'android' as const;
  private readonly avd: string;
  private readonly emulatorBin: string | undefined;
  private readonly adbBin: string;
  private readonly basePort: number;
  private readonly maxInstances: number;
  private readonly extraArgs: string[];
  private readonly bootTimeoutMs: number;
  private readonly launch: typeof android.launch;
  private readonly exec: CommandRunner;
  private readonly allocated = new Set<number>();
  /** Live handles for instances THIS process booted; lost across a restart. */
  private readonly devices = new Map<string, Device>();

  constructor(opts: AndroidEmulatorProviderOptions = {}) {
    this.avd = opts.avd ?? process.env.PHONE_USE_ANDROID_AVD ?? 'phone-use-golden';
    this.emulatorBin = opts.emulatorBin;
    this.adbBin = opts.adbBin ?? process.env.PHONE_USE_ADB_BIN ?? 'adb';
    this.basePort = opts.basePort ?? Number(process.env.PHONE_USE_ANDROID_BASE_PORT ?? 5554);
    this.maxInstances = opts.maxInstances ?? Number(process.env.PHONE_USE_WORKER_CAPACITY ?? 4);
    this.extraArgs = opts.extraArgs ?? (process.env.PHONE_USE_ANDROID_EMULATOR_ARGS ?? '').split(/\s+/).filter(Boolean);
    this.bootTimeoutMs = opts.bootTimeoutMs ?? Number(process.env.PHONE_USE_ANDROID_BOOT_TIMEOUT_MS ?? 180_000);
    this.launch = opts.launch ?? android.launch;
    this.exec = opts.exec ?? runCommand;
  }

  async provision(_sandbox: Pick<Sandbox, 'id'>): Promise<ProvisionedResource> {
    const port = this.takePort();
    const serial = `emulator-${port}`;
    try {
      const device = await this.launch({
        avd: this.avd,
        port,
        readOnly: true,
        headless: true,
        emulatorBin: this.emulatorBin,
        adbBin: this.adbBin,
        extraArgs: this.extraArgs,
        bootTimeoutMs: this.bootTimeoutMs,
        idleTimeoutMs: false,
      });
      this.devices.set(serial, device);
      return { deviceId: serial, name: `${this.avd} @${port}`, metadata: { port, avd: this.avd } };
    } catch (error) {
      this.allocated.delete(port);
      throw error;
    }
  }

  async destroy(resource: ProvisionedResource): Promise<void> {
    const device = this.devices.get(resource.deviceId);
    if (device) {
      await device.close();
      this.devices.delete(resource.deviceId);
    } else {
      // Adopted after a restart: no process handle, so ask the emulator
      // console to quit and let adb forget the serial.
      await this.exec(this.adbBin, ['-s', resource.deviceId, 'emu', 'kill']).catch(() => undefined);
    }
    const port = Number(resource.metadata?.port);
    if (Number.isInteger(port)) this.allocated.delete(port);
  }

  restore(resource: ProvisionedResource): void {
    const port = Number(resource.metadata?.port);
    if (Number.isInteger(port)) this.allocated.add(port);
  }

  private takePort(): number {
    for (let i = 0; i < this.maxInstances; i += 1) {
      const port = this.basePort + 2 * i;
      if (!this.allocated.has(port)) {
        this.allocated.add(port);
        return port;
      }
    }
    throw new Error(`emulator capacity exhausted (${this.maxInstances})`);
  }
}

export type WarmPoolHooks = {
  /**
   * Finishes a phone before it joins the pool, so whatever would slow its first
   * action is already done at handout. A failure leaves a usable, slower phone.
   */
  warmUp?: ((resource: ProvisionedResource) => Promise<void>) | undefined;
  /** Re-run on phones waiting in the pool so they don't go cold while idle. */
  keepWarm?: ((resource: ProvisionedResource) => Promise<void>) | undefined;
  keepWarmMs?: number | undefined;
  /**
   * Wait this long after a handout before rebuilding the pool. Booting a
   * replacement competes with the phones just handed out, on the same host.
   */
  refillDelayMs?: number | undefined;
};

export class WarmPoolProvider implements SandboxProvider {
  readonly platform: DevicePlatform;
  private readonly ready: ProvisionedResource[] = [];
  private filling = 0;
  private refreshing = false;

  constructor(
    private readonly inner: SandboxProvider,
    private readonly target: number,
    private readonly hooks: WarmPoolHooks = {},
  ) {
    this.platform = inner.platform;
  }

  start(): void {
    this.fill();
    // Orphans are not a startup-only condition: any close interrupted mid-flight
    // (worker killed, destroy failing on a saturated host) strands a BOOTED
    // simulator that no longer belongs to the pool or to a sandbox. Nothing
    // reclaimed those while the worker ran, so the host silently lost capacity
    // until someone restarted it — measured live at 7 warm booted against a
    // target of 3, leaving ~1 usable slot out of 8 and failing every session.
    setInterval(() => void this.sweepStaleWarm(), 300_000).unref?.();
    if (this.hooks.keepWarm) {
      setInterval(() => void this.refreshWarm(), this.hooks.keepWarmMs ?? 120_000).unref?.();
    }
  }

  /** One phone at a time, for the same reason fill() trickles: never a load burst. */
  async refreshWarm(): Promise<void> {
    if (this.refreshing || !this.hooks.keepWarm) return;
    this.refreshing = true;
    try {
      for (const resource of [...this.ready]) {
        if (!this.ready.includes(resource)) continue;
        await this.hooks.keepWarm(resource).catch((error) => {
          console.error(`warm pool: keep-warm failed for ${resource.deviceId}:`, error);
        });
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** Phones ready for instant handout, for health checks. */
  get warmReady(): number {
    return this.ready.length;
  }

  /**
   * Warm devices are not persisted: a worker restart forgets its pool and
   * fills a fresh one, orphaning booted `…-warm_*` simulators (seen live:
   * 4 booted where target was 1). The worker calls this AFTER adopting active
   * sandboxes — handed-out pool devices keep their warm names, so anything
   * adopted is protected; everything else warm-named is a leak.
   */
  async sweepStaleWarm(): Promise<void> {
    // A clone in flight has no UDID yet, so it cannot be recognised as ours and
    // would be swept the instant it appears. Never sweep mid-fill.
    if (this.filling > 0) return;
    const inner = this.inner as { destroy(resource: ProvisionedResource): Promise<void> };
    // Pool entries are warm-named and unprotected; only handed-out devices reach
    // protectedDevices. Both must survive a sweep — everything else is an orphan.
    const pooled = new Set(this.ready.map((resource) => resource.deviceId));
    try {
      const proc = Bun.spawn(['xcrun', 'simctl', 'list', 'devices', '-j'], { stdout: 'pipe' });
      const data = (await new Response(proc.stdout).json()) as {
        devices: Record<string, Array<{ udid: string; name: string }>>;
      };
      for (const list of Object.values(data.devices)) {
        for (const device of list) {
          if (
            device.name.includes('-warm_') &&
            !this.protectedDevices.has(device.udid) &&
            !pooled.has(device.udid)
          ) {
            console.warn(`warm pool: destroying stale ${device.name}`);
            await inner.destroy({ deviceId: device.udid, name: device.name }).catch(() => undefined);
          }
        }
      }
    } catch {
      /* simctl unavailable (tests/android) — nothing to sweep */
    }
  }

  /** Devices held warm plus those being built — the host is really using these. */
  get reserved(): number {
    return this.ready.length + this.filling;
  }

  async provision(sandbox: Pick<Sandbox, 'id' | 'platform'>): Promise<ProvisionedResource> {
    const resource = this.ready.shift();
    if (resource) {
      // Pool entries are pristine by construction: filled via inner.provision()
      // (a fresh clone) and handed out exactly once — nothing returns to the
      // pool. Handing over as-is is what makes warm allocation ~instant, and
      // it preserves the golden's pre-seeded, slimmed state (an erase here
      // would revert the device to factory and re-pay first-boot migration).
      // If devices are ever RECYCLED into the pool, that path must reset().
      //
      // A handed-out device KEEPS its warm name, so to the sweep it is
      // indistinguishable from an orphan. Protect it here or the periodic sweep
      // destroys live phones out from under their sessions.
      this.protectedDevices.add(resource.deviceId);
      const delay = this.hooks.refillDelayMs ?? 0;
      if (delay > 0) setTimeout(() => this.fill(), delay).unref?.();
      else this.fill();
      return resource;
    }
    const provisioned = await this.inner.provision(sandbox);
    this.protectedDevices.add(provisioned.deviceId);
    return provisioned;
  }

  async destroy(resource: ProvisionedResource): Promise<void> {
    await this.inner.destroy(resource);
    this.protectedDevices.delete(resource.deviceId);
    this.fill();
  }

  private readonly protectedDevices = new Set<string>();

  restore(resource: ProvisionedResource): void {
    this.protectedDevices.add(resource.deviceId);
    this.inner.restore?.(resource);
  }

  // Checkpoint verbs pass straight through, with one wrinkle: restore swaps the
  // device identity, and the OLD id must stay protected until the swap lands or
  // a concurrently running warm sweep could destroy the session's device
  // mid-restore. Protect new first, then drop old.
  checkpoint(resource: ProvisionedResource, name: string): Promise<{ checkpointUdid: string }> {
    if (!this.inner.checkpoint) return Promise.reject(new Error('provider does not support checkpoints'));
    return this.inner.checkpoint(resource, name);
  }

  async restoreCheckpoint(
    resource: ProvisionedResource,
    checkpointUdid: string,
    name: string,
  ): Promise<ProvisionedResource> {
    if (!this.inner.restoreCheckpoint) throw new Error('provider does not support checkpoints');
    const restored = await this.inner.restoreCheckpoint(resource, checkpointUdid, name);
    this.protectedDevices.add(restored.deviceId);
    this.protectedDevices.delete(resource.deviceId);
    return restored;
  }

  deleteCheckpoint(checkpointUdid: string): Promise<void> {
    if (!this.inner.deleteCheckpoint) return Promise.resolve();
    return this.inner.deleteCheckpoint(checkpointUdid);
  }

  private fill(): void {
    // Refill ONE device at a time. A handout of N phones used to trigger N
    // simultaneous clone+boot cycles, and each fresh boot drags minutes of
    // simulator indexing (axassetsd, diagnosticd) behind it — a load storm that
    // races the customer session that caused the handout. Measured live: host
    // load 529, every in-flight search timing out against the daemon. Warm
    // capacity can afford to trickle back; live sessions cannot afford to lose.
    if (this.filling > 0) return;
    if (this.ready.length >= this.target) return;
    this.filling += 1;
    const id = `warm_${randomUUID().replaceAll('-', '')}`;
    let failed = false;
    void this.inner
      .provision({ id, platform: this.platform })
      .then(async (resource) => {
        await this.hooks.warmUp?.(resource).catch((error) => {
          console.error(`warm pool: warm-up failed for ${resource.deviceId}:`, error);
        });
        this.ready.push(resource);
        console.log(`warm pool: ${this.ready.length}/${this.target} ready`);
      })
      .catch((error) => {
        failed = true;
        console.error('warm-pool provision failed:', error);
      })
      .finally(() => {
        this.filling -= 1;
        if (this.ready.length < this.target) {
          // Chain the next build immediately on success — a boot is its own
          // pacing. Back off only when a build failed.
          if (failed) setTimeout(() => this.fill(), 5_000).unref?.();
          else this.fill();
        }
      });
  }
}

/** Pull the created/cloned UDID out of simctl output (last line convention). */
function extractUdid(stdout: string): string | undefined {
  return stdout.match(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/i)?.[0];
}

/** Reject rather than hang: a wedged simulator must fail its session loudly. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
