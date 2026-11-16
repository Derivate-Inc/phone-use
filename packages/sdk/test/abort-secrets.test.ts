import { describe, expect, it } from 'vitest';
import { buildObserveResult, executeAction } from '../src/actions.ts';
import { AbortedError } from '../src/errors.ts';
import { DeviceCore } from '../src/observe.ts';
import { SecretStore } from '../src/secrets.ts';
import { el, FakeBackend, screen } from '../src/testing.ts';

const loginScreen = () =>
  screen(
    [
      el({
        ref: '@e1',
        type: 'TextField',
        label: 'Password',
        rect: { x: 0, y: 100, width: 390, height: 36 },
      }),
      el({ ref: '@e2', type: 'Button', label: 'Sign In', rect: { x: 0, y: 160, width: 390, height: 44 } }),
    ],
    { appName: 'Bank' },
  );

describe('AbortSignal', () => {
  it('pre-aborted signal throws AbortedError before any backend call', async () => {
    const fake = new FakeBackend({ screens: [loginScreen()] });
    const core = new DeviceCore(fake);
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeAction(
        core,
        { formatVersion: 0, verb: 'tap', target: { label: 'Sign In' } },
        { signal: controller.signal },
      ),
    ).rejects.toThrowError(AbortedError);
    expect(fake.calls.length).toBe(0);
  });

  it('mid-flight abort races a hung backend call and rejects promptly', async () => {
    // A backend whose press never resolves — raceWithAbort must return control.
    const fake = new FakeBackend({ screens: [loginScreen()] });
    const hung = new Proxy(fake, {
      get(target, prop, receiver) {
        if (prop === 'press') return () => new Promise(() => {});
        return Reflect.get(target, prop, receiver);
      },
    });
    const core = new DeviceCore(hung);
    await core.observe();
    const controller = new AbortController();
    const pending = executeAction(
      core,
      { formatVersion: 0, verb: 'tap', target: { label: 'Sign In' } },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrowError(AbortedError);
  });

  it('abort during the wait loop rejects between polls', async () => {
    const disabled = screen([
      el({
        ref: '@e1',
        type: 'Button',
        label: 'Continue',
        enabled: false,
        rect: { x: 0, y: 100, width: 200, height: 44 },
      }),
    ]);
    const core = new DeviceCore(new FakeBackend({ screens: [disabled] }));
    await core.observe();
    const controller = new AbortController();
    const pending = executeAction(
      core,
      { formatVersion: 0, verb: 'tap', target: { label: 'Continue' } },
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrowError(AbortedError);
  });
});

describe('%variable% secrets', () => {
  it('value reaches backend.fill; results and observations show %name%', async () => {
    const typed = screen(
      [
        el({
          ref: '@e1',
          type: 'TextField',
          label: 'Password',
          value: 'hunter22',
          rect: { x: 0, y: 100, width: 390, height: 36 },
        }),
        el({ ref: '@e2', type: 'Button', label: 'Sign In', rect: { x: 0, y: 160, width: 390, height: 44 } }),
      ],
      { appName: 'Bank' },
    );
    const fake = new FakeBackend({
      screens: [loginScreen(), typed],
      onAction: (c) => (c.method === 'fill' ? 1 : undefined),
    });
    const core = new DeviceCore(fake);
    const secrets = new SecretStore({ password: 'hunter22' });
    await core.observe();

    const r = await executeAction(
      core,
      { formatVersion: 0, verb: 'fill', target: { label: 'Password' }, params: { text: '%password%' } },
      {},
      secrets,
    );
    expect(r.success).toBe(true);
    // The VALUE went to the backend...
    const fillCall = fake.calls.find((c) => c.method === 'fill');
    expect(fillCall?.args).toEqual(['@e1', 'hunter22']);
    // ...but never appears in outbound text.
    expect(r.message).not.toContain('hunter22');

    // The next observation's field value is redacted back to %password%.
    const obs = await buildObserveResult(core, secrets);
    const field = obs.elements.find((e) => e.label === 'Password');
    expect(field?.value).toBe('%password%');
    expect(obs.rendered).not.toContain('hunter22');
    expect(obs.rendered).toContain('%password%');
  });

  it('per-call vars layer over the store; unknown %x% stays literal', async () => {
    const fake = new FakeBackend({ screens: [loginScreen()] });
    const core = new DeviceCore(fake);
    await core.observe();
    await executeAction(
      core,
      {
        formatVersion: 0,
        verb: 'fill',
        target: { label: 'Password' },
        params: { text: '%otp% and %unknown%' },
      },
      { vars: { otp: '123456' } },
    );
    const fillCall = fake.calls.find((c) => c.method === 'fill');
    expect(fillCall?.args[1]).toBe('123456 and %unknown%');
  });

  it('short secrets are refused at set()', () => {
    expect(() => new SecretStore({ pin: '12' })).toThrow(/too short/);
  });
});
