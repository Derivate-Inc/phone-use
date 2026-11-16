import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The backend asks launchd (via simctl) which apps are running when the
// runner falls back to SpringBoard. Stub that one host call; everything else
// goes over real HTTP to a fake runner.
const running = vi.hoisted(() => ({ apps: [] as string[], calls: 0 }));
vi.mock('../src/backends/ios-runner.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/backends/ios-runner.ts')>();
  return {
    ...real,
    runningApps: async () => {
      running.calls++;
      return running.apps;
    },
  };
});

import { currentBuildKey } from '../src/backends/ios-runner.ts';
import { createXctestBackend } from '../src/backends/xctest.ts';
import {
  ActionFailedError,
  type PhoneUseError,
  TimeoutError,
  UnsupportedCapabilityError,
} from '../src/errors.ts';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const TOKEN = 'test-token';

type Call = { method: string; params: Record<string, unknown>; auth: string | undefined };

/** A fake runner speaking protocol 2. `reply` decides each answer. */
function fakeRunner(
  reply: (call: Call) => unknown,
): Promise<{ server: Server; port: number; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ ok: true, protocol: 2 }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
      const call = { method: parsed.method, params: parsed.params ?? {}, auth: req.headers.authorization };
      calls.push(call);
      res.end(JSON.stringify(reply(call)));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, calls }),
    ),
  );
}

const settings = {
  app: { bundleId: 'com.apple.Preferences', name: 'Settings' },
  viewport: { width: 402, height: 874 },
  nodes: [
    { ref: 'e1', type: 'Application', label: 'Settings', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: 'e2', type: 'Cell', label: 'General', rect: { x: 16, y: 380, width: 370, height: 52 } },
    {
      ref: 'e3',
      type: 'Switch',
      label: 'Airplane Mode',
      value: '0',
      enabled: false,
      rect: { x: 300, y: 200, width: 51, height: 31 },
    },
  ],
  generation: 1,
  ms: 40,
};
const springboard = { ...settings, app: { bundleId: 'com.apple.springboard', name: '' }, nodes: [] };

let home: string;
let runner: Awaited<ReturnType<typeof fakeRunner>> | undefined;

/** Record the fake runner as the live runner for UDID, as ensureRunner would. */
function adopt(port: number): void {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(
    join(home, 'sessions', `${UDID}.json`),
    JSON.stringify({
      udid: UDID,
      port,
      token: TOKEN,
      url: `http://127.0.0.1:${port}`,
      pid: process.pid,
      buildKey: currentBuildKey(),
      startedAt: new Date().toISOString(),
      logPath: join(home, 'runner.log'),
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pu-runner-test-'));
  running.apps = [];
  running.calls = 0;
});

afterEach(() => {
  runner?.server.close();
  runner = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('xctest backend', () => {
  it('reuses a recorded runner, authenticates, and maps snapshot nodes', async () => {
    runner = await fakeRunner(() => ({ result: settings }));
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });

    const snap = await backend.snapshot({ interactiveOnly: true });

    expect(runner.calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(runner.calls[0]?.params).toMatchObject({ interactiveOnly: true });
    expect(snap.appBundleId).toBe('com.apple.Preferences');
    expect(snap.appName).toBe('Settings');
    expect(snap.nodes[1]).toMatchObject({
      ref: 'e2',
      type: 'Cell',
      role: 'Cell',
      label: 'General',
      enabled: true,
    });
    expect(snap.nodes[2]).toMatchObject({ value: '0', enabled: false });
    expect(snap.nodes[1]?.rect).toEqual({ x: 16, y: 380, width: 370, height: 52 });
  });

  it('hints the known app, and never hints SpringBoard', async () => {
    runner = await fakeRunner((call) => ({ result: call.method === 'snapshot' ? settings : { ok: true } }));
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });

    await backend.snapshot();
    await backend.snapshot();
    expect(runner.calls[1]?.params.bundleId).toBe('com.apple.Preferences');

    await backend.home();
    await backend.snapshot();
    expect(runner.calls.at(-1)?.params.bundleId).toBeUndefined();
  });

  it('asks launchd for running apps when the known app left the foreground', async () => {
    let first = true;
    runner = await fakeRunner((call) => {
      if (call.method !== 'snapshot') return { result: { ok: true } };
      if (first) {
        first = false;
        return { result: springboard };
      }
      return { result: call.params.candidates ? settings : springboard };
    });
    adopt(runner.port);
    running.apps = [
      'com.apple.Preferences',
      'dev.phoneuse.runner.uitests.xctrunner',
      'com.apple.springboard',
    ];
    const backend = createXctestBackend({ udid: UDID, home });

    const snap = await backend.snapshot();

    expect(running.calls).toBe(1);
    expect(runner.calls[1]?.params.candidates).toEqual(['com.apple.Preferences']);
    expect(snap.appBundleId).toBe('com.apple.Preferences');
  });

  it('does not ask launchd when it put SpringBoard in front itself', async () => {
    runner = await fakeRunner((call) => ({
      result: call.method === 'snapshot' ? springboard : { ok: true },
    }));
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });
    await backend.home();
    await backend.snapshot();
    expect(running.calls).toBe(0);
  });

  it('sends refs and coordinates as tap targets', async () => {
    runner = await fakeRunner(() => ({ result: { ok: true } }));
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });
    await backend.press({ ref: '@e2' });
    await backend.press({ x: 10, y: 20 });
    await backend.fill('e7', 'Ada');
    await backend.longPress('e3', 900);
    expect(runner.calls.map((c) => [c.method, c.params])).toEqual([
      ['tap', { ref: '@e2', diff: true }],
      ['tap', { x: 10, y: 20, diff: true }],
      ['fill', { ref: 'e7', text: 'Ada' }],
      ['long_press', { ref: 'e3', durationMs: 900 }],
    ]);
  });

  it('maps runner errors onto the typed error tree, keeping the hint', async () => {
    const errors: Record<string, { code: string; message: string; hint?: string }> = {
      tap: { code: 'STALE_REF', message: 'e9 is no longer on screen', hint: 'take a new snapshot' },
      wait_text: { code: 'TIMEOUT', message: '"Done" did not appear within 500ms' },
      key: { code: 'UNKNOWN_METHOD', message: 'unknown method key' },
      drag: { code: 'BAD_PARAMS', message: 'drag needs x, y, dx, dy' },
    };
    runner = await fakeRunner((call) => ({ error: errors[call.method] }));
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });

    const stale = await backend.press({ ref: 'e9' }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ActionFailedError);
    expect((stale as PhoneUseError).details?.backendCode).toBe('STALE_REF');
    expect((stale as PhoneUseError).details?.hint).toBe('take a new snapshot');

    await expect(backend.waitForText('Done', 500)).rejects.toBeInstanceOf(TimeoutError);
    await expect(backend.pressKey('return')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    const bad = await backend.pan(1, 2, 3, 4).catch((e: unknown) => e);
    expect((bad as PhoneUseError).retryable).toBe(false);
  });

  it('marks keyboard-covered controls and refuses to tap them without a retry', async () => {
    runner = await fakeRunner((call) =>
      call.method === 'snapshot'
        ? {
            result: {
              ...settings,
              nodes: [
                { ref: 'e1', type: 'Keyboard', rect: { x: 0, y: 540, width: 402, height: 334 } },
                {
                  ref: 'e2',
                  type: 'Cell',
                  label: 'add phone',
                  blocked: 'keyboard',
                  rect: { x: 16, y: 600, width: 370, height: 44 },
                },
              ],
            },
          }
        : {
            error: {
              code: 'OCCLUDED',
              message: 'e2 (Cell "add phone") is under the keyboard',
              hint: 'dismiss the keyboard',
            },
          },
    );
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });
    const snap = await backend.snapshot();
    expect(snap.nodes[1]?.interactionBlocked).toBe('keyboard');
    const err = (await backend.press({ ref: 'e2' }).catch((e: unknown) => e)) as PhoneUseError;
    expect(err.retryable).toBe(false);
    expect(err.details?.backendCode).toBe('OCCLUDED');
    expect(err.details?.hint).toBe('dismiss the keyboard');
  });

  it('reports alerts in the backend shape', async () => {
    runner = await fakeRunner(() => ({
      result: {
        alert: { title: 'Allow “Maps” to use your location?', buttons: ['Allow Once', 'Don’t Allow'] },
        handled: true,
        button: 'Don’t Allow',
      },
    }));
    adopt(runner.port);
    const backend = createXctestBackend({ udid: UDID, home });
    const result = await backend.systemAlert('dismiss');
    expect(runner.calls[0]?.params).toEqual({ action: 'dismiss' });
    expect(result).toEqual({
      alert: { title: 'Allow “Maps” to use your location?', buttons: ['Allow Once', 'Don’t Allow'] },
      handled: true,
      button: 'Don’t Allow',
    });
  });

  it('refuses to construct without a simulator', () => {
    expect(() => createXctestBackend({ udid: '' })).toThrow(/needs a simulator udid/);
  });
});
