import { describe, expect, it } from 'vitest';
import { type Action, buildObserveResult, executeAction } from '../src/actions.ts';
import { ActionFailedError, SessionNotFoundError } from '../src/errors.ts';
import { DeviceCore } from '../src/observe.ts';
import { el, FakeBackend, screen } from '../src/testing.ts';

const settingsScreen = () =>
  screen(
    [
      el({ ref: '@e1', type: 'Cell', label: 'General', rect: { x: 0, y: 100, width: 390, height: 44 } }),
      el({ ref: '@e2', type: 'Cell', label: 'Wi-Fi', rect: { x: 0, y: 150, width: 390, height: 44 } }),
      el({
        ref: '@e3',
        type: 'TextField',
        label: 'Search',
        rect: { x: 0, y: 200, width: 390, height: 36 },
      }),
    ],
    { appName: 'Settings' },
  );

const aboutScreen = () =>
  screen(
    [el({ ref: '@e1', type: 'Cell', label: 'iOS Version', rect: { x: 0, y: 100, width: 390, height: 44 } })],
    {
      appName: 'Settings',
    },
  );

describe('observe → Action[] → act round-trip (the skill-compiler seam)', () => {
  it('a serialized Action re-resolves on a FRESH core and executes with zero re-inference', async () => {
    // Observe on core 1.
    const core1 = new DeviceCore(new FakeBackend({ screens: [settingsScreen()] }));
    const obs = await buildObserveResult(core1);
    expect(obs.success).toBe(true);
    expect(obs.app).toBe('Settings');
    const tapGeneral = obs.actions.find((a) => a.verb === 'tap' && a.observed?.label === 'General');
    expect(tapGeneral).toBeDefined();

    // Serialize → deserialize → act on a completely fresh core/backend.
    const wire = JSON.parse(JSON.stringify(tapGeneral)) as Action;
    const fake2 = new FakeBackend({
      screens: [settingsScreen(), aboutScreen()],
      // Only the resolved ref-press transitions; scrollToTop's coordinate
      // press must not (it would yank the screen out from under the ladder).
      onAction: (c) =>
        c.method === 'press' && (c.args[0] as { ref?: string }).ref === '@e1' ? 1 : undefined,
    });
    const core2 = new DeviceCore(fake2);
    const result = await executeAction(core2, wire);

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.resolved?.label).toBe('General');
    // Exactly one REF press (the target); the ladder's scrollToTop coordinate
    // tap is the only other press allowed.
    const refPresses = fake2.calls.filter((c) => c.method === 'press' && 'ref' in (c.args[0] as object));
    expect(refPresses.length).toBe(1);
  });

  it('id-rung round-trip: a query with id wins over a colliding label', async () => {
    const s = screen([
      el({
        ref: '@e1',
        type: 'Button',
        label: 'Add',
        identifier: 'add-contact',
        rect: { x: 0, y: 100, width: 100, height: 44 },
      }),
      el({ ref: '@e2', type: 'Button', label: 'Add', rect: { x: 200, y: 100, width: 100, height: 44 } }),
    ]);
    const core = new DeviceCore(new FakeBackend({ screens: [s] }));
    const r = await executeAction(core, { formatVersion: 0, verb: 'tap', target: { id: 'add-contact' } });
    expect(r.success).toBe(true);
    expect(r.resolved?.ref).toBe('@e1');
    expect(r.resolved?.via).toContain('id');
  });
});

describe('never-throw contract', () => {
  it('unknown label → structured failure, no throw', async () => {
    const core = new DeviceCore(new FakeBackend({ screens: [settingsScreen()] }));
    const r = await executeAction(
      core,
      { formatVersion: 0, verb: 'tap', target: { label: 'Nonexistent' } },
      { timeoutMs: 300 },
    );
    expect(r.success).toBe(false);
    expect(r.code).toBe('TIMEOUT');
  });

  it('ambiguity → candidates surfaced structurally; role disambiguates', async () => {
    const s = screen([
      el({
        ref: '@e1',
        type: 'Button',
        label: 'Add Contact',
        rect: { x: 0, y: 100, width: 100, height: 44 },
      }),
      el({ ref: '@e2', type: 'Cell', label: 'Add Photo', rect: { x: 0, y: 150, width: 100, height: 44 } }),
    ]);
    const core = new DeviceCore(new FakeBackend({ screens: [s] }));
    await core.observe();
    const ambiguous = await executeAction(core, { formatVersion: 0, verb: 'tap', target: { label: 'add' } });
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.candidates?.length).toBe(2);

    const disambiguated = await executeAction(core, {
      formatVersion: 0,
      verb: 'tap',
      target: { label: 'add', role: 'Cell' },
    });
    expect(disambiguated.success).toBe(true);
    expect(disambiguated.resolved?.label).toBe('Add Photo');
  });

  it('a row and a same-named control nested inside it are one target, not an ambiguity', async () => {
    // Settings > General: the "About" row is a Cell "About" holding a Button "About".
    const s = screen([
      el({ ref: '@e1', type: 'Cell', label: 'About', rect: { x: 20, y: 391, width: 362, height: 53 } }),
      el({ ref: '@e2', type: 'Button', label: 'About', rect: { x: 34, y: 404, width: 28, height: 28 } }),
      el({
        ref: '@e3',
        type: 'Cell',
        label: 'Screen Capture',
        rect: { x: 20, y: 444, width: 362, height: 53 },
      }),
    ]);
    const core = new DeviceCore(new FakeBackend({ screens: [s] }));
    await core.observe();

    const row = await executeAction(core, { formatVersion: 0, verb: 'tap', target: { label: 'About' } });
    expect(row.success).toBe(true);
    expect(row.resolved?.role).toBe('Cell');

    // An explicit role still reaches the inner control.
    const inner = await executeAction(core, {
      formatVersion: 0,
      verb: 'tap',
      target: { label: 'About', role: 'Button' },
    });
    expect(inner.success).toBe(true);
    expect(inner.resolved?.role).toBe('Button');
  });

  it('two separate controls with the same label are still ambiguous', async () => {
    const s = screen([
      el({ ref: '@e1', type: 'Cell', label: 'Delete', rect: { x: 0, y: 100, width: 390, height: 44 } }),
      el({ ref: '@e2', type: 'Button', label: 'Delete', rect: { x: 0, y: 600, width: 390, height: 44 } }),
    ]);
    const core = new DeviceCore(new FakeBackend({ screens: [s] }));
    await core.observe();
    const r = await executeAction(core, { formatVersion: 0, verb: 'tap', target: { label: 'Delete' } });
    expect(r.success).toBe(false);
    expect(r.candidates?.length).toBe(2);
  });

  it('gesture-level ActionFailedError → structured failure with code', async () => {
    const fake = new FakeBackend({
      screens: [settingsScreen()],
      failWith: (c) => (c.method === 'press' ? new ActionFailedError('press hit a wall') : undefined),
    });
    const core = new DeviceCore(fake);
    await core.observe();
    const r = await executeAction(core, { formatVersion: 0, verb: 'tap', target: { label: 'General' } });
    expect(r.success).toBe(false);
    expect(r.code).toBe('ACTION_FAILED');
    expect(r.message).toContain('press hit a wall');
  });

  it('infrastructure SessionNotFoundError on a gesture THROWS', async () => {
    const fake = new FakeBackend({
      screens: [settingsScreen()],
      failWith: (c) => (c.method === 'press' ? new SessionNotFoundError('gone') : undefined),
    });
    const core = new DeviceCore(fake);
    await core.observe();
    await expect(
      executeAction(core, { formatVersion: 0, verb: 'tap', target: { label: 'General' } }),
    ).rejects.toThrowError(SessionNotFoundError);
  });

  it('observe under SessionNotFoundError stays structured (friendly no-session message)', async () => {
    const fake = new FakeBackend({
      screens: [settingsScreen()],
      failWith: (c) => (c.method === 'snapshot' ? new SessionNotFoundError('no session') : undefined),
    });
    const core = new DeviceCore(fake);
    const obs = await buildObserveResult(core);
    expect(obs.success).toBe(true);
    expect(obs.message).toContain('No app session');
    expect(obs.elements).toEqual([]);
  });
});

describe('auto-wait', () => {
  it('fast path: fresh cache + actionable target → exactly ONE snapshot during act (the tapAndDiff one)', async () => {
    const fake = new FakeBackend({ screens: [settingsScreen()] });
    const core = new DeviceCore(fake);
    await core.observe(); // freshens the cache
    const snapshotsBefore = fake.calls.filter((c) => c.method === 'snapshot').length;
    const r = await executeAction(core, { formatVersion: 0, verb: 'tap', target: { label: 'General' } });
    expect(r.success).toBe(true);
    const snapshotsDuringAct = fake.calls.filter((c) => c.method === 'snapshot').length - snapshotsBefore;
    expect(snapshotsDuringAct).toBe(1); // docs/20 risk-2 latency tripwire
    expect(r.waited).toBeUndefined();
  });

  it('disabled target becomes enabled after a poll → succeeds with waited.polls ≥ 1', async () => {
    const disabled = screen([
      el({
        ref: '@e1',
        type: 'Button',
        label: 'Continue',
        enabled: false,
        rect: { x: 0, y: 100, width: 200, height: 44 },
      }),
    ]);
    const enabled = screen([
      el({ ref: '@e1', type: 'Button', label: 'Continue', rect: { x: 0, y: 100, width: 200, height: 44 } }),
    ]);
    let snaps = 0;
    const fake = new FakeBackend({
      screens: [disabled, enabled],
      onAction: (c) => {
        if (c.method === 'snapshot') {
          snaps++;
          if (snaps >= 3) return 1; // enable after a couple of polls
        }
        return undefined;
      },
    });
    const core = new DeviceCore(fake);
    await core.observe();
    const r = await executeAction(
      core,
      { formatVersion: 0, verb: 'tap', target: { label: 'Continue' } },
      { timeoutMs: 5000 },
    );
    expect(r.success).toBe(true);
    expect(r.waited?.polls).toBeGreaterThanOrEqual(1);
  });

  it('never enables → structured TIMEOUT within the deadline', async () => {
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
    const started = Date.now();
    const r = await executeAction(
      core,
      { formatVersion: 0, verb: 'tap', target: { label: 'Continue' } },
      { timeoutMs: 700 },
    );
    expect(r.success).toBe(false);
    expect(r.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.message).toContain('Continue');
  });
});

describe('non-target verbs', () => {
  it('scroll / back / home / openApp return structured successes', async () => {
    const fake = new FakeBackend({ screens: [settingsScreen()] });
    const core = new DeviceCore(fake);
    expect(
      (await executeAction(core, { formatVersion: 0, verb: 'scroll', params: { direction: 'down' } }))
        .success,
    ).toBe(true);
    expect((await executeAction(core, { formatVersion: 0, verb: 'back' })).success).toBe(true);
    expect((await executeAction(core, { formatVersion: 0, verb: 'home' })).success).toBe(true);
    const open = await executeAction(core, {
      formatVersion: 0,
      verb: 'openApp',
      params: { app: 'Settings' },
    });
    expect(open.success).toBe(true);
    expect(fake.calls.map((c) => c.method)).toContain('openApp');
  });

  it('missing params → structured failures', async () => {
    const core = new DeviceCore(new FakeBackend({ screens: [settingsScreen()] }));
    expect((await executeAction(core, { formatVersion: 0, verb: 'openApp' })).success).toBe(false);
    expect((await executeAction(core, { formatVersion: 0, verb: 'openUrl' })).success).toBe(false);
    expect((await executeAction(core, { formatVersion: 0, verb: 'tap' })).success).toBe(false);
  });
});
