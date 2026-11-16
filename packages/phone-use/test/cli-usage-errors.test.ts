import { afterEach, describe, expect, it } from 'vitest';
import { cliVerb, execCliTool, parseCliArgs, toolHelp } from '../src/cli.ts';
import { setMode } from '../src/permissions.ts';
import type { ToolDef } from '../src/registry.ts';
import { toolFailed } from '../src/tool-status.ts';

// A call that cannot work must fail as a usage error: exit 1, before any
// permission prompt, and never as a success a script would trust. None of
// these reach a device: they stop at argument checks.

afterEach(() => setMode('default'));

const verb = (name: string) => cliVerb(name) as ToolDef;
const run = (name: string, argv: string[]) => execCliTool(verb(name), parseCliArgs(verb(name), argv));

describe('missing required arguments', () => {
  it('toggle without the switch says what is missing instead of asking to confirm', async () => {
    const outcome = await run('toggle', ['Reduce Motion', '--on']);
    expect(outcome.code).toBe(1);
    expect(outcome.out).toContain('toggle needs <switch>');
    expect(outcome.out).not.toContain('CONFIRMATION REQUIRED');
  });

  it('goto without a destination is a usage error', async () => {
    const outcome = await run('goto', ['Settings']);
    expect(outcome.code).toBe(1);
    expect(outcome.out).toContain('goto needs <destination>');
  });

  it('--help still works with nothing else given', async () => {
    expect((await run('toggle', ['--help'])).code).toBe(0);
  });
});

describe('usage errors a handler reports as text', () => {
  it('count as failures for every renderer', () => {
    expect(toolFailed('tap needs label, ref, or at={x,y}.')).toBe(true);
    expect(toolFailed('open needs app or url.')).toBe(true);
    expect(toolFailed('note save needs content.')).toBe(true);
    expect(toolFailed('batch needs a non-empty actions array. Valid shapes: …')).toBe(true);
    expect(toolFailed('batch action 1 is invalid — unknown do: undefined')).toBe(true);
    expect(toolFailed('Scroll stopped: "Developer" was not found; reached the end of the list')).toBe(true);
    expect(toolFailed('press failed: this phone cannot press that key')).toBe(true);
  });

  it('leave ordinary results alone', () => {
    expect(toolFailed('Tapped "General" (matched via exact label).')).toBe(false);
    expect(toolFailed('Scrolled down 2 time(s): "Developer" is on screen.')).toBe(false);
    expect(toolFailed('Pressed return.')).toBe(false);
    expect(toolFailed('No notes saved yet.')).toBe(false);
  });

  it('a malformed batch exits 1 and runs nothing', async () => {
    const outcome = await run('batch', ['[{"tool":"tap"}]', '--yes']);
    expect(outcome.code).toBe(1);
    expect(outcome.out).toContain('Nothing was run');
  });

  it('bare tap exits 1', async () => {
    expect((await run('tap', [])).code).toBe(1);
  });
});

describe('help names the arguments', () => {
  it('batch help shows the action shapes', () => {
    const help = toolHelp(verb('batch'));
    expect(help).toContain('arguments:');
    expect(help).toContain("{do:'tap', label}");
  });

  it('press help lists the keys', () => {
    expect(toolHelp(verb('press'))).toContain('return|tab|backspace|space|escape');
  });
});

describe('press', () => {
  it('asks before pressing a key, like typing does', async () => {
    const outcome = await run('press', ['return']);
    expect(outcome.code).toBe(3);
    expect(outcome.out).toContain('the return key');
  });

  it('rejects a key it does not know', async () => {
    const outcome = await run('press', ['f13']);
    expect(outcome.code).toBe(1);
    expect(outcome.out).toContain('must be one of');
  });
});
