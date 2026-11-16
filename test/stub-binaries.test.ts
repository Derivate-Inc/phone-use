import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Proof of the PATH-stub mechanism the DI'd-spawn-runner test tier stands on
// (doc 19: fake simctl/adb binaries catch argv-quoting and stream bugs mocks
// miss). Spawns through PATH exactly like production code would.

const exec = promisify(execFile);
const stubsDir = fileURLToPath(new URL('./stubs', import.meta.url));
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${stubsDir}:${process.env.PATH}`,
  ...extra,
});

describe.each(['simctl', 'adb', 'xcrun'])('stub binary: %s', (bin) => {
  it('round-trips hostile argv without shell interpolation', async () => {
    const argv = ['io', 'has spaces', 'quote"inside', '$HOME', '--flag=a b', 'ünïcodé✓'];
    const { stdout } = await exec(bin, argv, { env: env() });
    const parsed = JSON.parse(stdout) as { stub: string; argv: string[] };
    expect(parsed.stub).toBe(bin);
    expect(parsed.argv).toEqual(argv); // deep equality: no splitting, no expansion
  });

  it('propagates exit codes', async () => {
    await expect(exec(bin, ['boot'], { env: env({ STUB_EXIT: '3' }) })).rejects.toMatchObject({ code: 3 });
  });

  it('routes stderr separately from stdout', async () => {
    const { stdout, stderr } = await exec(bin, ['list'], { env: env({ STUB_STDERR: 'warning: fake' }) });
    expect(stderr).toBe('warning: fake');
    expect(JSON.parse(stdout)).toMatchObject({ stub: bin });
  });

  it('drains a 1 MiB stdout without pipe deadlock', async () => {
    const { stdout } = await exec(bin, ['screenshot'], {
      env: env({ STUB_STDOUT_BYTES: String(1024 * 1024) }),
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(stdout.length).toBe(1024 * 1024);
  });
});
