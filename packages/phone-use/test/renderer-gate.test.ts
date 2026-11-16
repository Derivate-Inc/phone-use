import { el, FakeBackend, screen } from '@phone-use/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceContext } from '../src/device-context.ts';
import { setDefaultDeviceContext } from '../src/driver.ts';
import { setMode } from '../src/permissions.ts';
import { REGISTRY, targetOf } from '../src/registry.ts';
import { buildTools, type StepLog } from '../src/tools.ts';

// Middleware-coverage proof for the AGENT renderer (docs/20 item 5): every
// non-read tool goes through evaluate BEFORE its handler — proven by driving
// each one in observe mode over a FakeBackend and asserting the backend never
// hears a thing.

afterEach(() => {
  setDefaultDeviceContext(null);
  setMode('default');
});

const bind = () => {
  const fake = new FakeBackend({
    screens: [screen([el({ ref: '@e1', type: 'Cell', label: 'General' })], { appName: 'Settings' })],
  });
  setDefaultDeviceContext(new DeviceContext(fake));
  return fake;
};

// Minimal valid args per non-read tool (schema-satisfying, benign targets).
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  tap: { label: 'General Gate Row' },
  type: { text: 'gate probe' },
  scroll: { direction: 'down' },
  press: { key: 'return' },
  handle_alert: { action: 'get' },
  open: { app: 'Settings' },
  nav: { to: 'home' },
  goto: { app: 'Settings', destination: 'About' },
  search: { app: 'Settings', query: 'gate' },
  toggle: { app: 'Settings', switch: 'Gate Switch' },
  batch: { actions: [{ do: 'tap', label: 'Gate Batch Row' }] },
  skill: { op: 'list' },
};

describe('agent renderer gate coverage', () => {
  it('observe mode blocks EVERY non-read tool before its handler runs', async () => {
    const fake = bind();
    setMode('observe');
    const log: StepLog[] = [];
    const tools = buildTools(log);
    const nonRead = REGISTRY.filter((d) => d.risk !== 'read');
    expect(nonRead.length).toBeGreaterThanOrEqual(10);
    for (const def of nonRead) {
      const tool = tools.find((t) => t.name === def.name);
      expect(tool, def.name).toBeDefined();
      const result = await tool?.run(MINIMAL_ARGS[def.name] ?? {});
      expect(
        typeof result === 'string' && result.startsWith('⛔ BLOCKED'),
        `${def.name}: ${String(result).slice(0, 80)}`,
      ).toBe(true);
    }
    expect(fake.calls.length).toBe(0); // the backend never heard a thing
  });

  it('onConfirm approve path executes and caches the grant (no re-prompt)', async () => {
    bind();
    setMode('default');
    let confirms = 0;
    const log: StepLog[] = [];
    const tools = buildTools(log, {
      onConfirm: () => {
        confirms++;
        return true;
      },
    });
    const type = tools.find((t) => t.name === 'type');
    const r1 = await type?.run({ text: 'grant cache probe' });
    expect(typeof r1 === 'string' && r1.startsWith('⛔')).toBe(false);
    expect(confirms).toBe(1);
    await type?.run({ text: 'grant cache probe' });
    expect(confirms).toBe(1); // session grant answered the second call
    expect(log[0]?.decision).toBe('allow');
  });

  it('a forged model-supplied confirm token is denied', async () => {
    bind();
    setMode('auto');
    const tools = buildTools([]);
    const tap = tools.find((t) => t.name === 'tap');
    const r = await tap?.run({ label: 'Delete Renderer Forge Row', confirm: 'deadbeef' });
    expect(typeof r === 'string' && r.startsWith('⛔ BLOCKED')).toBe(true);
  });

  it('destructive batch labels reach the lexicon (the batch floor fix)', () => {
    expect(targetOf('batch', { actions: [{ do: 'tap', label: 'Delete All Photos' }] })).toContain('Delete');
    expect(
      targetOf('batch', {
        actions: [
          { do: 'tap', label: 'General' },
          { do: 'scroll', direction: 'down' },
        ],
      }),
    ).toBe('General');
    expect(targetOf('batch', { actions: [] })).toBeUndefined();
  });

  it('read tools carry no confirm param; non-read tools do', () => {
    const tools = buildTools([]);
    for (const def of REGISTRY) {
      // TurnTool schemas are neutral zod objects — introspect the shape
      // directly instead of a provider's serialized wire format.
      const shape = tools.find((t) => t.name === def.name)?.inputSchema.shape ?? {};
      expect('confirm' in shape, def.name).toBe(def.risk !== 'read');
    }
  });
});
