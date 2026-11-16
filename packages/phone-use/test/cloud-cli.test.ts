import { describe, expect, it } from 'vitest';
import { parseDuration, runSandboxCli } from '../src/cloud-cli.ts';

describe('cloud CLI durations', () => {
  it('parses compact duration flags', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('rejects ambiguous values', () => {
    expect(() => parseDuration('15')).toThrow('invalid duration');
  });
});

describe('cloud CLI errors', () => {
  it('reports "not signed in" as one line and exit 1, not a stack trace', async () => {
    const saved = { token: process.env.PHONE_USE_CLOUD_TOKEN, error: console.error };
    const lines: string[] = [];
    Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runSandboxCli(['list'])).toBe(1);
      expect(await runSandboxCli(['create', 'ios'])).toBe(1);
    } finally {
      console.error = saved.error;
      if (saved.token !== undefined) process.env.PHONE_USE_CLOUD_TOKEN = saved.token;
    }
    expect(lines).toEqual([
      'Not signed in — run `phone-use login` (or set PHONE_USE_CLOUD_TOKEN)',
      'Not signed in — run `phone-use login` (or set PHONE_USE_CLOUD_TOKEN)',
    ]);
  });
});
