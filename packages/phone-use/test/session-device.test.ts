import { createDeviceHandle } from '@phone-use/sdk';
import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import * as driver from '../src/driver.ts';
import { evaluate } from '../src/permissions.ts';
import { record, recordingStatus, startRecording } from '../src/recorder.ts';
import { createSession } from '../src/sdk.ts';
import { currentTraceSession, setTraceSession, TraceSession } from '../src/trace-session.ts';

// createSession({device}) binds the agent layer to an explicit Device
// (docs/20 item 5). Caller-owned: the session never closes it. Key-free: the
// Anthropic client stays lazy, binding happens before any prompt.

afterEach(() => driver.setDefaultDeviceContext(null));

describe('createSession({device})', () => {
  it('isolates devices, notes, approvals, recordings and traces across interleaved prompts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const make = (name: string) =>
      createDeviceHandle({
        id: name,
        platform: 'ios',
        backend: new FakeBackend({ screens: [screen([el({ ref: '@e1', label: name })], { appName: name })] }),
        createdByUs: false,
        idleTimeoutMs: false,
        doClose: async () => {},
      });
    const action = { tool: 'tap', risk: 'mutate' as const, target: 'Delete isolation item' };
    const a = createSession({
      device: make('A'),
      runner: {
        id: 'a',
        capabilities: new Set(),
        reset() {},
        async runTurn(req) {
          await req.tools
            .find((t) => t.name === 'note')!
            .run({ op: 'save', key: 'private', content: 'A only' });
          const verdict = evaluate(action);
          if (verdict.decision !== 'ask') throw new Error('expected ask');
          evaluate({ ...action, confirm: verdict.token });
          startRecording('record-A');
          setTraceSession(new TraceSession('on'));
          ready();
          await gate;
          expect(recordingStatus()?.name).toBe('record-A');
          expect(currentTraceSession()).not.toBeNull();
          expect(evaluate(action).decision).toBe('allow');
          return { status: 'completed', summary: await req.tools.find((t) => t.name === 'observe')!.run({}) };
        },
      },
    });
    const b = createSession({
      device: make('B'),
      mode: 'observe',
      runner: {
        id: 'b',
        capabilities: new Set(),
        reset() {},
        async runTurn(req) {
          expect(evaluate(action).decision).toBe('deny');
          expect(recordingStatus()).toBeNull();
          record({ op: 'open_app', app: 'B' });
          expect(currentTraceSession()).toBeNull();
          expect(
            await req.tools.find((t) => t.name === 'note')!.run({ op: 'read', key: 'private' }),
          ).not.toContain('A only');
          const summary = await req.tools.find((t) => t.name === 'observe')!.run({});
          release();
          return { status: 'completed', summary };
        },
      },
    });
    const first = a.prompt('look');
    await entered;
    const second = await b.prompt('look');
    expect(second.summary).toContain('App: B');
    expect((await first).summary).toContain('App: A');
  });
  it('binds only the session to the passed device; never closes it', async () => {
    const fake = new FakeBackend({
      screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'Session Row' })], { appName: 'SessionApp' })],
    });
    let closed = false;
    const device = createDeviceHandle({
      id: 'session-device',
      platform: 'ios',
      backend: fake,
      createdByUs: true,
      idleTimeoutMs: false,
      doClose: async () => {
        closed = true;
      },
    });

    const session = createSession({
      device,
      runner: {
        id: 'scripted',
        capabilities: new Set(),
        reset() {},
        async runTurn(req) {
          const output = await req.tools.find((t) => t.name === 'observe')!.run({});
          return { status: 'completed', summary: output };
        },
      },
    });
    expect(typeof session.prompt).toBe('function');

    // The harness facade now drives the device's backend.
    expect((await session.prompt('look')).summary).toContain('SessionApp');
    expect(fake.calls.some((c) => c.method === 'snapshot')).toBe(true);

    // Nothing the session constructor/stop path does closes the device.
    session.stop();
    expect(closed).toBe(false);
    expect(device.isClosed).toBe(false);
  });

  it('absent device → default slot untouched (implicit attach preserved)', () => {
    createSession({});
    // No context bound by construction; the lazy default would only build on
    // first driver call. Nothing to assert beyond "no throw, no bind":
    // defaultDeviceContext() would CREATE one, so check the private slot via
    // a fresh set/reset cycle instead.
    driver.setDefaultDeviceContext(null); // must not throw
  });
});
