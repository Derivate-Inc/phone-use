import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, mergeSettings, PROJECT_CONFIG_NAME } from '../src/settings.ts';

describe('mergeSettings', () => {
  it('applies PHONE_USE_* keys the environment leaves unset', () => {
    const r = mergeSettings({}, [{ path: 'user.json', values: { PHONE_USE_DEVICE: 'launch' } }]);
    expect(r.applied).toEqual({ PHONE_USE_DEVICE: 'launch' });
    expect(r.warnings).toEqual([]);
  });

  it('the real environment always wins', () => {
    const r = mergeSettings({ PHONE_USE_DEVICE: 'ABCD' }, [
      { path: 'user.json', values: { PHONE_USE_DEVICE: 'launch' } },
    ]);
    expect(r.applied).toEqual({});
  });

  it('earlier layers (project) win over later ones (user)', () => {
    const r = mergeSettings({}, [
      { path: 'project.json', values: { PHONE_USE_MODE: 'observe' } },
      { path: 'user.json', values: { PHONE_USE_MODE: 'auto', PHONE_USE_DEVICE: 'connect' } },
    ]);
    expect(r.applied).toEqual({ PHONE_USE_MODE: 'observe', PHONE_USE_DEVICE: 'connect' });
  });

  it('refuses ANTHROPIC_API_KEY with a warning', () => {
    const r = mergeSettings({}, [{ path: 'user.json', values: { ANTHROPIC_API_KEY: 'sk-x' } }]);
    expect(r.applied).toEqual({});
    expect(r.warnings[0]).toContain('ANTHROPIC_API_KEY belongs in the environment');
  });

  it('warns on unknown keys and non-scalar values', () => {
    const r = mergeSettings({}, [
      { path: 'u.json', values: { device: 'launch', PHONE_USE_DEVICE: { udid: 'x' } } },
    ]);
    expect(r.applied).toEqual({});
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('unknown key "device"');
    expect(r.warnings[1]).toContain('must be a string, number, or boolean');
  });

  it('stringifies numbers and booleans', () => {
    const r = mergeSettings({}, [{ path: 'u.json', values: { PHONE_USE_LIVE_PORT: 5000 } }]);
    expect(r.applied).toEqual({ PHONE_USE_LIVE_PORT: '5000' });
  });
});

describe('loadSettings', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.PHONE_USE_TEST_SETTING;
  });

  it('loads a project config into process.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pu-settings-'));
    dirs.push(dir);
    writeFileSync(join(dir, PROJECT_CONFIG_NAME), JSON.stringify({ PHONE_USE_TEST_SETTING: 'yes' }));
    const r = loadSettings(dir);
    expect(r.applied.PHONE_USE_TEST_SETTING).toBe('yes');
    expect(process.env.PHONE_USE_TEST_SETTING).toBe('yes');
  });

  it('warns (not throws) on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pu-settings-'));
    dirs.push(dir);
    writeFileSync(join(dir, PROJECT_CONFIG_NAME), '{not json');
    const r = loadSettings(dir);
    expect(r.warnings.some((w) => w.includes('invalid config'))).toBe(true);
  });
});

describe('selectBackendKind precedence', () => {
  it('an explicit env PHONE_USE_DEVICE beats a sandbox URL', async () => {
    const { selectBackendKind } = await import('../src/driver.ts');
    expect(
      selectBackendKind({ PHONE_USE_DEVICE: 'android', PHONE_USE_SANDBOX_URL: 'https://w/x' }, false),
    ).toBe('android');
    expect(
      selectBackendKind({ PHONE_USE_DEVICE: 'mirror', PHONE_USE_SANDBOX_URL: 'https://w/x' }, false),
    ).toBe('mirror');
  });

  it('a sandbox URL beats a config-defaulted PHONE_USE_DEVICE', async () => {
    const { selectBackendKind } = await import('../src/driver.ts');
    expect(
      selectBackendKind({ PHONE_USE_DEVICE: 'android', PHONE_USE_SANDBOX_URL: 'https://w/x' }, true),
    ).toBe('sandbox');
  });

  it('a config-defaulted device still applies when no sandbox URL is set', async () => {
    const { selectBackendKind } = await import('../src/driver.ts');
    expect(selectBackendKind({ PHONE_USE_DEVICE: 'android' }, true)).toBe('android');
  });

  it('falls through sandbox → runner → local', async () => {
    const { selectBackendKind } = await import('../src/driver.ts');
    expect(selectBackendKind({ PHONE_USE_SANDBOX_URL: 'https://w/x' }, false)).toBe('sandbox');
    expect(selectBackendKind({ PHONE_USE_RUNNER_URL: 'http://r' }, false)).toBe('runner');
    expect(selectBackendKind({}, false)).toBe('local');
  });

  it('loadSettings marks config-applied keys as defaults', async () => {
    const { isConfigDefault } = await import('../src/settings.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pu-settings-'));
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_NAME), JSON.stringify({ PHONE_USE_TEST_SETTING: 'a' }));
      loadSettings(dir);
      expect(isConfigDefault('PHONE_USE_TEST_SETTING')).toBe(true);
      expect(isConfigDefault('PHONE_USE_SANDBOX_URL')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.PHONE_USE_TEST_SETTING;
    }
  });
});
