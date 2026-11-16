/**
 * What the iPhone Mirroring window says when it is not showing the phone.
 *
 * These screens are macOS views, not phone pixels: they read as ordinary text
 * to OCR, taps meant for the phone go nowhere on them, and only the person
 * holding the phone can clear them. Recognising them turns "the tap did
 * nothing" into "lock your iPhone".
 */
export type MirrorBlock = { said: string; fix: string };

const BLOCKS: { test: RegExp; fix: string }[] = [
  {
    test: /\biphone in use\b/i,
    fix: 'The iPhone is being used. Lock it and leave it nearby; Mirroring reconnects by itself.',
  },
  {
    test: /\bunlock (your )?iphone\b/i,
    fix: 'Follow the prompt on the iPhone: unlock it once with its passcode, then leave it nearby.',
  },
  {
    test: /\btimed out\b/i,
    fix: 'The session timed out. Lock the iPhone, then press the button in the Mirroring window to connect again.',
  },
  { test: /\block your iphone\b/i, fix: 'Lock the iPhone and leave it nearby.' },
  {
    test: /\b(unable|failed|could not|couldn.t) to connect\b|\bconnection failed\b/i,
    fix: 'Mirroring could not reach the iPhone. Keep it nearby and locked, with Wi-Fi and Bluetooth on, then try again in the window.',
  },
];

/** An interstitial is a handful of lines; a phone screen with one of these phrases in it has far more. */
const MAX_INTERSTITIAL_LINES = 10;

/** The block the window's text describes, or null when it is showing the phone. */
export function mirrorBlock(texts: readonly string[]): MirrorBlock | null {
  const lines = texts.map((t) => t.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_INTERSTITIAL_LINES) return null;
  for (const block of BLOCKS) {
    const hit = lines.find((line) => block.test.test(line));
    if (hit) return { said: lines.slice(0, 3).join(' · '), fix: block.fix };
  }
  return null;
}

/** One sentence an agent can pass on to the person at the phone. */
export function describeBlock(block: MirrorBlock): string {
  return `iPhone Mirroring is not showing the phone. The window says: "${block.said}". ${block.fix} Only the person at the phone can do this; ask them, then run the command again.`;
}
