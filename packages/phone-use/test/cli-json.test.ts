import { describe, expect, it } from 'vitest';
import { cliVerb, jsonEnvelope, parseCliArgs } from '../src/cli.ts';

const tap = cliVerb('tap');
if (!tap) throw new Error('tap verb missing from registry');

describe('--json flag', () => {
  it('is recognized on any verb without reaching the schema', () => {
    const parsed = parseCliArgs(tap, ['General', '--json']);
    expect(parsed).toMatchObject({ ok: true, json: true, args: { label: 'General' } });
  });

  it('defaults off', () => {
    const parsed = parseCliArgs(tap, ['General']);
    expect(parsed).toMatchObject({ ok: true, json: false });
  });
});

describe('jsonEnvelope', () => {
  it('maps exit codes to statuses', () => {
    expect(JSON.parse(jsonEnvelope(tap, { out: 'Tapped', code: 0 }))).toEqual({
      tool: 'tap',
      status: 'ok',
      exitCode: 0,
      output: 'Tapped',
    });
    expect(JSON.parse(jsonEnvelope(tap, { out: 'x', code: 2 })).status).toBe('blocked');
    expect(JSON.parse(jsonEnvelope(tap, { out: 'x', code: 3 })).status).toBe('confirm_required');
  });
});
