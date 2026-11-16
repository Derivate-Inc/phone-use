import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDeviceHandle, type DeviceBackend } from '@phone-use/sdk';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { setMode } from '../src/permissions.ts';
import { type OpenPhoneDeps, openPhones, type Phone, parsePhoneSpecs } from '../src/phones.ts';

// One MCP server, several phones (PHONE_USE_DEVICES): each tool call names its
// phone and reaches only that phone's backend. Key-free and device-free.

afterEach(() => {
  setDefaultDeviceContext(null);
  setMode('default');
});

const UDID_A = '11111111-1111-1111-1111-111111111111';
const UDID_B = '22222222-2222-2222-2222-222222222222';

const fakeFor = (label: string) =>
  new FakeBackend({
    screens: [
      screen([el({ ref: '@e1', type: 'Button', label: `${label} Button` })], { appName: `${label} App` }),
    ],
  });

/** An `ios` engine double: connect/launch hand out FakeBackend devices and record closes. */
function fakeIos(backends: Record<string, FakeBackend>, closed: string[] = [], failLaunch = false) {
  let launches = 0;
  const handle = (
    id: string,
    backend: DeviceBackend,
    createdByUs: boolean,
    opts: { coreFactory?: unknown },
  ) =>
    createDeviceHandle({
      id,
      platform: 'ios',
      backend,
      createdByUs,
      idleTimeoutMs: false,
      coreFactory: opts.coreFactory as never,
      doClose: async () => {
        closed.push(id);
      },
    });
  return {
    connect: async (udid: string | undefined, opts: { coreFactory?: unknown } = {}) => {
      const id = udid ?? UDID_A;
      const backend = backends[id];
      if (!backend) throw new Error(`no simulator with udid ${id}`);
      return handle(id, backend, false, opts);
    },
    launch: async (opts: { coreFactory?: unknown } = {}) => {
      if (failLaunch) throw new Error('simulator failed to boot');
      launches++;
      const id = `LAUNCHED-${launches}`;
      return handle(id, fakeFor(id), true, opts);
    },
  } as unknown as NonNullable<OpenPhoneDeps['ios']>;
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as ToolResult).content.find((c) => c.type === 'text')?.text ?? '';

async function serve(phones: Phone[]) {
  delete process.env.ANTHROPIC_API_KEY;
  const { buildMcpServer } = await import('../src/mcp.ts');
  const server = buildMcpServer(phones);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'phones-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('parsePhoneSpecs', () => {
  it('reads named and positional phones', () => {
    expect(parsePhoneSpecs(`ios=${UDID_A}, pixel=android:emulator-5554 c=cloud:sb_1`)).toEqual([
      { name: 'ios', spec: UDID_A },
      { name: 'pixel', spec: 'android:emulator-5554' },
      { name: 'c', spec: 'cloud:sb_1' },
    ]);
    expect(parsePhoneSpecs('launch,launch')).toEqual([
      { name: 'a', spec: 'launch' },
      { name: 'b', spec: 'launch' },
    ]);
  });

  it('refuses empty lists, bad names, missing devices and duplicate names', () => {
    expect(() => parsePhoneSpecs(' , ')).toThrow(/empty/);
    expect(() => parsePhoneSpecs('1st=launch')).toThrow(/not a usable phone name/);
    expect(() => parsePhoneSpecs('a=')).toThrow(/has no device/);
    expect(() => parsePhoneSpecs('a=launch,a=launch')).toThrow(/Two phones are named "a"/);
  });
});

describe('openPhones', () => {
  it('opens simulators, Android and cloud phones, leasing only shared simulators', async () => {
    const phones = await openPhones(
      parsePhoneSpecs(`a=${UDID_A},b=launch,c=android:emulator-5554,d=cloud:sb_9`),
      {
        ios: fakeIos({ [UDID_A]: fakeFor('A') }),
        android: {
          connect: async (serial: string | undefined, opts: { coreFactory?: unknown } = {}) =>
            createDeviceHandle({
              id: serial ?? 'none',
              platform: 'android',
              backend: fakeFor('C'),
              createdByUs: false,
              idleTimeoutMs: false,
              coreFactory: opts.coreFactory as never,
              doClose: async () => {},
            }),
        } as unknown as NonNullable<OpenPhoneDeps['android']>,
        cloud: async () => ({ endpoint: 'https://worker.example/s/sb_9', token: 't', platform: 'ios' }),
      },
    );
    expect(phones.map((p) => [p.name, p.platform, p.leaseUdid, p.deviceId])).toEqual([
      ['a', 'ios', UDID_A, UDID_A],
      ['b', 'ios', null, 'LAUNCHED-1'],
      ['c', 'android', null, 'emulator-5554'],
      ['d', 'ios', null, 'cloud:sb_9'],
    ]);
    expect(phones[3]?.label).toBe('cloud iPhone sb_9');
    // Notes are shared; everything else is per phone.
    expect(phones[0]?.execution.notes).toBe(phones[1]?.execution.notes);
    expect(phones[0]?.execution.device).not.toBe(phones[1]?.execution.device);
  });

  it('refuses one device under two names, and closes what it launched when any phone fails', async () => {
    const closed: string[] = [];
    await expect(
      openPhones(parsePhoneSpecs(`a=${UDID_A},b=${UDID_A}`), { ios: fakeIos({ [UDID_A]: fakeFor('A') }) }),
    ).rejects.toThrow(/a and b are the same device/);

    await expect(
      openPhones(parsePhoneSpecs(`a=launch,b=${UDID_B}`), { ios: fakeIos({}, closed) }),
    ).rejects.toThrow(/b: no simulator with udid/);
    expect(closed).toEqual(['LAUNCHED-1']);

    await expect(openPhones(parsePhoneSpecs('a=mirror'), {})).rejects.toThrow(/"mirror" is not a device/);
  });
});

describe('MCP with several phones', () => {
  async function twoPhones() {
    const a = fakeFor('Alpha');
    const b = fakeFor('Bravo');
    const phones = await openPhones(parsePhoneSpecs(`a=${UDID_A},b=${UDID_B}`), {
      ios: fakeIos({ [UDID_A]: a, [UDID_B]: b }),
    });
    // Leasing real simulators is device-lease.ts's job, tested there.
    for (const p of phones) p.leaseUdid = null;
    return { a, b, client: await serve(phones) };
  }

  it('tells the agent which phones it has and adds `phone` to every tool but note', async () => {
    const { client } = await twoPhones();
    expect(client.getInstructions()).toContain(`- a: iOS simulator ${UDID_A} (default)`);
    expect(client.getInstructions()).toContain(`- b: iOS simulator ${UDID_B}`);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
      if (tool.name === 'note') expect(props.phone, tool.name).toBeUndefined();
      else expect(props.phone?.enum, tool.name).toEqual(['a', 'b']);
    }
  });

  it('routes each call to its phone, defaults to the first, and names the phone in the result', async () => {
    const { a, b, client } = await twoPhones();
    const onB = textOf(await client.callTool({ name: 'observe', arguments: { phone: 'b' } }));
    expect(onB.startsWith('[phone b] ')).toBe(true);
    expect(onB).toContain('Bravo Button');
    expect(onB).not.toContain('Alpha');

    const onDefault = textOf(await client.callTool({ name: 'observe', arguments: {} }));
    expect(onDefault.startsWith('[phone a] ')).toBe(true);
    expect(onDefault).toContain('Alpha Button');

    const tapped = textOf(
      await client.callTool({ name: 'tap', arguments: { phone: 'b', label: 'Bravo Button' } }),
    );
    expect(tapped.startsWith('[phone b] ')).toBe(true);
    const taps = (f: FakeBackend) =>
      f.calls.filter((c) => c.method.startsWith('tap') || c.method === 'press');
    expect(taps(b).length).toBeGreaterThan(0);
    expect(taps(a)).toEqual([]);

    const bad = (await client.callTool({ name: 'observe', arguments: { phone: 'z' } })) as ToolResult;
    expect(bad.isError).toBe(true);
  });

  it('runs calls on different phones at the same time without mixing them up', async () => {
    const { client } = await twoPhones();
    const results = await Promise.all(
      ['a', 'b', 'a', 'b'].map((phone) => client.callTool({ name: 'observe', arguments: { phone } })),
    );
    expect(results.map(textOf).map((t) => [t.slice(0, 9), t.includes('Alpha'), t.includes('Bravo')])).toEqual(
      [
        ['[phone a]', true, false],
        ['[phone b]', false, true],
        ['[phone a]', true, false],
        ['[phone b]', false, true],
      ],
    );
  });

  it('shares the note scratchpad between phones', async () => {
    const { client } = await twoPhones();
    await client.callTool({ name: 'note', arguments: { op: 'save', key: 'otp', content: '424242' } });
    const read = textOf(await client.callTool({ name: 'note', arguments: { op: 'read', key: 'otp' } }));
    expect(read).toContain('424242');
  });

  it('keeps confirmation tokens per phone: a token from phone b does not unlock phone a', async () => {
    const { client } = await twoPhones();
    setMode('auto');
    const target = 'Delete Everything';
    const ask = textOf(await client.callTool({ name: 'tap', arguments: { phone: 'b', label: target } }));
    expect(ask).toContain('CONFIRMATION REQUIRED');
    const token = ask.match(/confirm: "([a-z0-9]+)"/)?.[1];
    expect(token).toBeDefined();
    const onA = textOf(
      await client.callTool({ name: 'tap', arguments: { phone: 'a', label: target, confirm: token } }),
    );
    expect(onA).toContain('⛔ BLOCKED');
    const onB = textOf(
      await client.callTool({ name: 'tap', arguments: { phone: 'b', label: target, confirm: token } }),
    );
    expect(onB.startsWith('[phone b] ⛔')).toBe(false);
  });
});
