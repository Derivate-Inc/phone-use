import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultExecRunner } from '../src/exec.ts';
import { ios } from '../src/index.ts';
import type { ExecRunner } from '../src/testing.ts';

// The one integration-tier lifecycle test: launch + close through the REAL
// defaultExecRunner (actual process spawn), resolved to the xcrun PATH stub.
// Proves the spawn path end to end — argv assembly, stdout parsing, exit-code
// handling — that the scripted-runner unit tier can't.

const stubsDir = fileURLToPath(new URL('./stubs', import.meta.url));

describe('ios lifecycle through the PATH-stub tier', () => {
  it('launch → close issues the full simctl sequence with a parsed udid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pu-ios-stub-'));
    const argvLog = join(dir, 'argv.jsonl');
    const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    writeFileSync(join(dir, 'create.out'), `${udid}\n`);
    writeFileSync(join(dir, 'boot.out'), '');
    writeFileSync(join(dir, 'bootstatus.out'), 'Device already booted, nothing to do.\n');
    writeFileSync(join(dir, 'shutdown.out'), '');
    writeFileSync(join(dir, 'delete.out'), '');

    // Wrap the real runner to inject the stubbed PATH + fixture env — the
    // spawn itself is real (docs/19: stub binaries catch what mocks miss).
    const env = {
      ...process.env,
      PATH: `${stubsDir}:${process.env.PATH}`,
      STUB_STDOUT_DIR: dir,
      STUB_ARGV_LOG: argvLog,
    } as Record<string, string>;
    const exec: ExecRunner = (file, args, opts) => defaultExecRunner(file, args, { ...opts, env });

    const device = await ios.launch({ exec, idleTimeoutMs: false, name: 'stub-run' });
    expect(device.id).toBe(udid);
    await device.close();

    const seq = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(seq.map((a) => a[1])).toEqual(['create', 'boot', 'bootstatus', 'shutdown', 'delete']);
    expect(seq[0]).toEqual(['simctl', 'create', 'stub-run', 'iPhone 16']);
    expect(seq[1]).toEqual(['simctl', 'boot', udid]);
    expect(seq[4]).toEqual(['simctl', 'delete', udid]);
  });
});
