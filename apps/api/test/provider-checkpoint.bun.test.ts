import { describe, expect, it } from 'bun:test';
import { IosSimulatorProvider } from '../src/providers.ts';

const CKPT_UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const NEW_UDID = '11111111-2222-3333-4444-555555555555';

type Call = { command: string; args: string[] };

/** Fake exec that records every simctl invocation and scripts clone output. */
function fakeExec(opts: { cloneUdid: string; failBootOf?: string }) {
  const calls: Call[] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push({ command, args });
    const verb = args[1];
    if (verb === 'clone') return { stdout: `${opts.cloneUdid}\n`, stderr: '' };
    if (verb === 'boot' && opts.failBootOf && args[2] === opts.failBootOf) {
      throw new Error(`boot of ${args[2]} failed`);
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, exec };
}

const simctl = (calls: Call[]) => calls.filter((c) => c.command === 'xcrun').map((c) => c.args.slice(1));

describe('IosSimulatorProvider checkpoints', () => {
  it('checkpoint: shutdown → clone → boot again, and the phone reboots even if clone throws', async () => {
    const { calls, exec } = fakeExec({ cloneUdid: CKPT_UDID });
    const provider = new IosSimulatorProvider({ exec, bootTimeoutMs: 1_000 });
    const result = await provider.checkpoint({ deviceId: 'LIVE-UDID' }, 'phone-use-ckpt-sbx-1');
    expect(result.checkpointUdid).toBe(CKPT_UDID);
    expect(simctl(calls)).toEqual([
      ['shutdown', 'LIVE-UDID'],
      ['clone', 'LIVE-UDID', 'phone-use-ckpt-sbx-1'],
      ['boot', 'LIVE-UDID'],
      ['bootstatus', 'LIVE-UDID', '-b'],
    ]);
  });

  it('restore: boots the clone BEFORE deleting the old device', async () => {
    const { calls, exec } = fakeExec({ cloneUdid: NEW_UDID });
    const provider = new IosSimulatorProvider({ exec, bootTimeoutMs: 1_000 });
    const restored = await provider.restoreCheckpoint(
      { deviceId: 'LIVE-UDID' },
      CKPT_UDID,
      'phone-use-cloud-sbx-1',
    );
    expect(restored.deviceId).toBe(NEW_UDID);
    expect(simctl(calls)).toEqual([
      ['clone', CKPT_UDID, 'phone-use-cloud-sbx-1'],
      ['boot', NEW_UDID],
      ['bootstatus', NEW_UDID, '-b'],
      ['shutdown', 'LIVE-UDID'],
      ['delete', 'LIVE-UDID'],
    ]);
  });

  it('failed restore deletes the half-made clone and leaves the live device alone', async () => {
    const { calls, exec } = fakeExec({ cloneUdid: NEW_UDID, failBootOf: NEW_UDID });
    const provider = new IosSimulatorProvider({ exec, bootTimeoutMs: 1_000 });
    await expect(
      provider.restoreCheckpoint({ deviceId: 'LIVE-UDID' }, CKPT_UDID, 'phone-use-cloud-sbx-1'),
    ).rejects.toThrow('boot of');
    const invocations = simctl(calls);
    expect(invocations).toContainEqual(['delete', NEW_UDID]);
    expect(invocations).not.toContainEqual(['delete', 'LIVE-UDID']);
    expect(invocations).not.toContainEqual(['shutdown', 'LIVE-UDID']);
  });

  it('deleteCheckpoint tolerates an already-gone artifact', async () => {
    const exec = async (_command: string, args: string[]) => {
      if (args[1] === 'delete') throw new Error('Invalid device: gone');
      return { stdout: '', stderr: '' };
    };
    const provider = new IosSimulatorProvider({ exec, bootTimeoutMs: 1_000 });
    await expect(provider.deleteCheckpoint(CKPT_UDID)).resolves.toBeUndefined();
  });
});
