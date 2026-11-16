import { android, createCloudSandboxBackend, type DeviceBackend, ios } from '@phone-use/sdk';
import { CloudClient } from './cloud-client.ts';
import { DeviceContext } from './device-context.ts';
import { setDefaultDeviceContext } from './driver.ts';
import { createExecution, type ExecutionContext } from './execution-context.ts';
import { currentMode } from './permissions.ts';
import { sharedTaskNotes } from './registry.ts';
import { currentTraceSession } from './trace-session.ts';

// ---------------------------------------------------------------------------
// Several phones behind one MCP server, so one agent can drive them together:
// send a message on one and read it on the other, or run the same flow on an
// iPhone and an Android phone.
//
// PHONE_USE_DEVICES (or `phone-use mcp --devices`) names the phones:
//   a=<udid>,b=launch,c=android:emulator-5554,d=cloud:<sandbox-id>
// Every tool then takes an optional `phone` argument; leaving it out uses the
// first phone. Each phone runs in its own ExecutionContext, so its screen
// cache, app list, confirmation tokens and skill recording stay its own. The
// `note` scratchpad is shared on purpose: it is how a value read on one phone
// reaches another.
// ---------------------------------------------------------------------------

export type PhoneSpec = { name: string; spec: string };

export type Phone = {
  name: string;
  /** What the agent is told this phone is, e.g. "iOS simulator 1A2B…". */
  label: string;
  platform: 'ios' | 'android';
  ctx: DeviceContext;
  execution: ExecutionContext;
  /** A shared local simulator this server must lease on every call; null for private or remote phones. */
  leaseUdid: string | null;
  /** The device's own id (udid, adb serial, sandbox id), used to refuse one device under two names. */
  deviceId: string;
  /** This server created the device (a launched simulator) and must delete it on exit. */
  owned: boolean;
  /** Close what this server created (a launched simulator); attached phones are left running. */
  close(): Promise<void>;
};

const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;
const NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/i;

export const DEVICES_HELP =
  'PHONE_USE_DEVICES lists the phones as name=device, separated by commas: ' +
  'a=<simulator udid>, b=launch (a new simulator, deleted on exit), c=connect (the one booted simulator), ' +
  'd=android or d=android:<serial>, e=cloud:<sandbox id>. A bare device is named a, b, c… by position.';

/** Parse `a=<udid>,b=launch,…` into named specs. Throws on bad or duplicate names. */
export function parsePhoneSpecs(value: string): PhoneSpec[] {
  const items = value.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) throw new Error(`PHONE_USE_DEVICES is empty. ${DEVICES_HELP}`);
  const specs = items.map((item, i) => {
    const eq = item.indexOf('=');
    const name = eq === -1 ? String.fromCharCode(97 + i) : item.slice(0, eq);
    const spec = eq === -1 ? item : item.slice(eq + 1);
    if (!NAME_RE.test(name))
      throw new Error(
        `"${name}" is not a usable phone name: start with a letter, then letters, digits, - or _.`,
      );
    if (!spec) throw new Error(`Phone ${name} has no device. ${DEVICES_HELP}`);
    return { name, spec };
  });
  const seen = new Set<string>();
  for (const { name } of specs) {
    if (seen.has(name)) throw new Error(`Two phones are named "${name}" in PHONE_USE_DEVICES.`);
    seen.add(name);
  }
  return specs;
}

/** Test seams: where devices and cloud credentials come from. */
export type OpenPhoneDeps = {
  ios?: Pick<typeof ios, 'launch' | 'connect'> | undefined;
  android?: Pick<typeof android, 'connect'> | undefined;
  cloud?: ((id: string) => Promise<CloudPhone>) | undefined;
};

export type CloudPhone = { endpoint: string; token: string; platform: 'ios' | 'android' };

/** A running cloud phone's endpoint and session token, from the signed-in account. */
async function cloudConnection(id: string): Promise<CloudPhone> {
  const client = new CloudClient();
  let sandbox = await client.get(id);
  // The connection is attached a moment after the status flips to running.
  for (let i = 0; i < 10 && sandbox.status === 'running' && !sandbox.connection; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    sandbox = await client.get(id);
  }
  if (sandbox.status !== 'running') throw new Error(`cloud phone ${id} is ${sandbox.status}`);
  if (!sandbox.connection) throw new Error(`cloud phone ${id} is running but has no connection yet; retry`);
  return { ...sandbox.connection, platform: sandbox.platform };
}

function makeExecution(ctx: DeviceContext, platform: 'ios' | 'android'): ExecutionContext {
  const execution = createExecution(ctx, currentMode(), platform);
  execution.notes = sharedTaskNotes();
  execution.trace = currentTraceSession();
  return execution;
}

async function openPhone({ name, spec }: PhoneSpec, deps: OpenPhoneDeps): Promise<Phone> {
  let core: DeviceContext | null = null;
  const common = {
    idleTimeoutMs: false as const,
    coreFactory: (backend: DeviceBackend) => {
      core = new DeviceContext(backend);
      return core;
    },
  };
  const bound = (): DeviceContext => {
    if (!core) throw new Error(`phone ${name}: the device opened without a harness context`);
    return core;
  };

  if (spec === 'launch' || spec === 'connect' || UDID_RE.test(spec)) {
    const api = deps.ios ?? ios;
    const owned = spec === 'launch';
    const device = owned
      ? await api.launch(common)
      : await api.connect(spec === 'connect' ? undefined : spec, common);
    const ctx = bound();
    return {
      name,
      label: `iOS simulator ${device.id}${owned ? ' (created for this session)' : ''}`,
      platform: 'ios',
      ctx,
      execution: makeExecution(ctx, 'ios'),
      leaseUdid: owned ? null : device.id,
      deviceId: device.id,
      owned,
      close: owned ? () => device.close() : async () => {},
    };
  }

  if (spec === 'android' || spec.startsWith('android:')) {
    const api = deps.android ?? android;
    const serial = spec === 'android' ? process.env.PHONE_USE_ANDROID_SERIAL : spec.slice('android:'.length);
    const device = await api.connect(serial || undefined, {
      ...common,
      ...(process.env.PHONE_USE_ADB_BIN ? { adbBin: process.env.PHONE_USE_ADB_BIN } : {}),
    });
    const ctx = bound();
    return {
      name,
      label: `Android ${device.id}`,
      platform: 'android',
      ctx,
      execution: makeExecution(ctx, 'android'),
      leaseUdid: null,
      deviceId: device.id,
      owned: false,
      close: async () => {},
    };
  }

  if (spec.startsWith('cloud:')) {
    const id = spec.slice('cloud:'.length);
    if (!id) throw new Error(`Phone ${name}: cloud: needs a sandbox id (phone-use list shows them).`);
    const conn = await (deps.cloud ?? cloudConnection)(id);
    const ctx = new DeviceContext(createCloudSandboxBackend({ endpoint: conn.endpoint, token: conn.token }));
    return {
      name,
      label: `cloud ${conn.platform === 'ios' ? 'iPhone' : 'Android phone'} ${id}`,
      platform: conn.platform,
      ctx,
      execution: makeExecution(ctx, conn.platform),
      leaseUdid: null,
      deviceId: `cloud:${id}`,
      owned: false,
      // The cloud phone's lifetime is the account's (phone-use close <id>), not this server's.
      close: async () => {},
    };
  }

  throw new Error(`Phone ${name}: "${spec}" is not a device. ${DEVICES_HELP}`);
}

/**
 * Open every phone at once (simulator launches run in parallel). If any fails,
 * close the ones that opened and throw. The first phone also becomes the
 * process default, so the live viewer and anything outside a tool call show it.
 */
export async function openPhones(specs: readonly PhoneSpec[], deps: OpenPhoneDeps = {}): Promise<Phone[]> {
  const settled = await Promise.allSettled(specs.map((s) => openPhone(s, deps)));
  const opened = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failures = settled.flatMap((r, i) =>
    r.status === 'rejected'
      ? [`${specs[i]?.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`]
      : [],
  );
  const byDevice = new Map<string, string>();
  for (const phone of opened) {
    const other = byDevice.get(phone.deviceId);
    if (other) failures.push(`${other} and ${phone.name} are the same device (${phone.deviceId})`);
    byDevice.set(phone.deviceId, phone.name);
  }
  if (failures.length) {
    await Promise.all(opened.map((p) => p.close().catch(() => undefined)));
    throw new Error(`Could not open the phones: ${failures.join('; ')}`);
  }
  const first = opened[0];
  if (first) setDefaultDeviceContext(first.ctx);
  return opened;
}

/** The server instructions that tell the agent which phones it has. */
export function describePhones(phones: readonly Phone[]): string {
  const rows = phones.map((p, i) => `- ${p.name}: ${p.label}${i === 0 ? ' (default)' : ''}`);
  return [
    `This server drives ${phones.length} phones:`,
    ...rows,
    `Every tool except note takes \`phone\` to choose one; leaving it out uses ${phones[0]?.name}.`,
    'Each result starts with the phone it came from. Calls to different phones can run at the same time.',
    'The note scratchpad is shared by all phones, so a value read on one phone can be typed on another.',
  ].join('\n');
}
