import { describe, expect, it } from 'vitest';
import { describeBlock, mirrorBlock } from '../src/mirror/blocked.ts';

// The iPhone Mirroring window shows macOS interstitials (a lock prompt,
// "iPhone in Use") that read as ordinary text. They must be told apart from a
// phone screen, or input is sent to a window that cannot take it.
describe('mirrorBlock', () => {
  it('recognises the unlock prompt', () => {
    const block = mirrorBlock([
      'Unlock iPhone',
      'Follow the instructions on "My iPhone" to unlock and',
      'use it on this Mac.',
      'Your iPhone will be fully accessible from this Mac when connected.',
    ]);
    expect(block?.fix).toMatch(/unlock it once/i);
    expect(block?.said).toContain('Unlock iPhone');
  });

  it('recognises a phone that is in use', () => {
    expect(mirrorBlock(['iPhone in Use', 'Lock your iPhone to connect.', 'Try Again'])?.fix).toMatch(
      /lock it/i,
    );
  });

  it('recognises a timed-out session', () => {
    expect(mirrorBlock(['Timed Out', 'Connection ended due to iPhone use.'])?.fix).toMatch(/timed out/i);
  });

  it('treats a normal phone screen as ready', () => {
    expect(mirrorBlock(['9:41', 'Weather', 'Photos', 'Calendar', 'Clock', 'Mail', 'Notes'])).toBeNull();
    expect(mirrorBlock([])).toBeNull();
  });

  it('does not mistake a busy screen that happens to contain the words', () => {
    const page = Array.from({ length: 14 }, (_, i) => `Result ${i}`);
    expect(mirrorBlock([...page, 'What to do when it says iPhone in Use'])).toBeNull();
  });

  it('gives one sentence a person can act on', () => {
    const block = mirrorBlock(['iPhone in Use', 'Try Again']);
    expect(block && describeBlock(block)).toMatch(/Only the person at the phone can do this/);
  });
});
