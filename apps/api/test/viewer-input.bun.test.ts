import { describe, expect, it } from 'bun:test';
import { ViewerInputs, parseViewerInput } from '../src/viewer-input.ts';
const gesture = { start: { x: .5, y: .25 }, width: 1206, height: 2622 };
describe('native viewer input', () => {
  it('rejects malformed input and strips unknown native fields', () => {
    expect(parseViewerInput({ ...gesture, buttonInjection: 'paste' })).toEqual({ ...gesture, durationMs: 300 });
    for (const input of [null, {}, { ...gesture, start: { x: NaN, y: 0 } },
      { ...gesture, end: { x: 2, y: 0 } }, { ...gesture, durationMs: 10000 },
      { button: 'paste' }, { text: '' }, { text: 'x'.repeat(2001) }]) expect(() => parseViewerInput(input)).toThrow();
  });
  it('passes text through stdin and pastes only after successful clipboard input', async () => {
    const calls: { command: string[]; input: string }[] = [];
    const inputs = new ViewerInputs(async (command, input) => { calls.push({ command, input }); });
    await inputs.send('device', { text: 'literal `echo test` $HOME\nhello' });
    expect(calls[0]).toEqual({ command: ['xcrun', 'simctl', 'pbcopy', 'device'], input: 'literal `echo test` $HOME\nhello' });
    expect(JSON.parse(calls[1]!.input)).toEqual({ button: 'paste' });
    let attempts = 0;
    const failing = new ViewerInputs(async () => { attempts++; throw new Error('failed'); });
    await expect(failing.send('device', { text: 'test' })).rejects.toThrow('failed');
    expect(attempts).toBe(1);
  });
  it('prevents overlapping gestures and releases the device after failure', async () => {
    let release!: () => void;
    const inputs = new ViewerInputs(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = inputs.send('device', gesture);
    await expect(inputs.send('device', gesture)).rejects.toThrow('in progress');
    release(); await first;
    const next = inputs.send('device', { button: 'home' }); release(); await next;
  });
});
