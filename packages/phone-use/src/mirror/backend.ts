/**
 * Drive a REAL iPhone over Apple's iPhone Mirroring window.
 *
 * Every other backend talks to a simulator through XCTest and gets a true
 * accessibility tree. There is no such tree here: Mirroring is a video feed of
 * a physical phone, and the Mac side knows nothing about the iOS view
 * hierarchy. So this backend synthesises a tree from Vision OCR — each piece of
 * recognised text becomes a node with a label and a rect — which is enough for
 * every label-driven verb in the CLI to work unchanged.
 *
 * What that costs, stated plainly so callers can plan around it:
 *   * No roles, no state. A toggle reads the same whether it is on or off, so
 *     anything that depends on `selected` or `enabled` cannot be answered here.
 *   * Text only. Icon-only buttons are invisible to OCR; tap them by
 *     coordinate.
 *   * OCR misreads. Labels come back with the occasional wrong character.
 *
 * The upside is the part no simulator can offer: real App Store apps, real
 * accounts, real hardware.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AlertAction,
  BackendAlertResult,
  OpenAppResult,
  PressTarget,
  ScrollDirection,
  Snapshot,
  SnapshotNode,
} from '@phone-use/sdk';
import { BaseDeviceBackend } from '@phone-use/sdk';

const BIN_DIR = join(homedir(), '.phone-use', 'bin');
const BIN = join(BIN_DIR, 'phone-use-mirror');
const SOURCE = join(dirname(new URL(import.meta.url).pathname), 'helper.swift');

/** OCR box as the helper reports it: window-relative points, top-left origin. */
type Box = { text: string; x: number; y: number; w: number; h: number; confidence: number };
type WindowInfo = { x: number; y: number; w: number; h: number; id: number; frontmost: boolean };

/**
 * Build the native helper if it is missing or older than its source. Swift is
 * used rather than a scripting runtime so driving a real phone adds no
 * dependency beyond the Xcode tools a Mac host already has.
 */
export async function ensureHelper(): Promise<string> {
  const fresh = existsSync(BIN) && existsSync(SOURCE) && statSync(BIN).mtimeMs >= statSync(SOURCE).mtimeMs;
  if (fresh) return BIN;
  mkdirSync(BIN_DIR, { recursive: true });
  const build = Bun.spawn(['swiftc', '-O', '-o', BIN, SOURCE], { stderr: 'pipe' });
  if ((await build.exited) !== 0) {
    throw new Error(
      `could not build the iPhone Mirroring helper (needs Xcode command line tools):\n${await new Response(build.stderr).text()}`,
    );
  }
  return BIN;
}

async function helper<T>(...args: string[]): Promise<T> {
  const bin = await ensureHelper();
  const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    // A raw helper error ("no iPhone Mirroring window found") tells an agent
    // nothing actionable, and it will happily invent theories about the app
    // instead. Replace it with the full preflight, which names the missing
    // prerequisite and how to grant it.
    const { preflightMirror, formatPreflight } = await import('./preflight.ts');
    const pre = await preflightMirror();
    if (!pre.ok) {
      throw new Error(
        `the real-iPhone backend is not ready:\n\n${formatPreflight(pre)}\n\n(underlying error: ${err.trim()})`,
      );
    }
    throw new Error(err.trim() || `mirror ${args[0]} failed`);
  }
  return JSON.parse(out || 'null') as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MirrorBackend extends BaseDeviceBackend {
  /** Rects from the last snapshot, so a @ref survives until the next observe. */
  private refs = new Map<string, Box>();
  private window: WindowInfo | null = null;

  constructor() {
    super('iphone-mirroring', [
      'snapshot',
      'screenshot',
      'press',
      'longPress',
      'fill',
      'type',
      'key',
      'scroll',
      'pan',
      'waitForText',
      'home',
      'back',
      'openApp',
    ]);
  }

  private async win(): Promise<WindowInfo> {
    this.window = await helper<WindowInfo>('window');
    return this.window;
  }

  override async snapshot(): Promise<Snapshot> {
    let [boxes, win] = await Promise.all([helper<Box[]>('ocr'), this.win()]);
    // Mirroring pauses itself (idle, or the phone was picked up). The pause
    // screen OCRs as ordinary text, and its Resume/Connect button is native
    // macOS UI that background clicks cannot press — an agent would tap the
    // streamed pixels forever. Heal it here: one focus-steal click, then look
    // again. "iPhone in Use" only recovers once the phone is locked again, so
    // a still-paused second read is reported as-is rather than retried.
    if (boxes.some((b) => /connection paused|mirroring ended/i.test(b.text))) {
      const healed = await helper<{ action: string }>('resume');
      if (healed.action === 'clicked') {
        [boxes, win] = await Promise.all([helper<Box[]>('ocr'), this.win()]);
      }
    }
    this.refs.clear();
    const nodes: SnapshotNode[] = [
      {
        ref: '@m0',
        type: 'Application',
        role: 'Application',
        label: 'iPhone (mirrored)',
        rect: { x: 0, y: 0, width: win.w, height: win.h },
      },
    ];
    boxes
      // Vision emits low-confidence noise for icons and dividers; those become
      // phantom labels an agent will try to tap.
      .filter((b) => b.confidence >= 0.3 && b.text.trim().length > 0)
      .forEach((b, i) => {
        const ref = `@m${i + 1}`;
        this.refs.set(ref, b);
        nodes.push({
          ref,
          type: 'StaticText',
          // Role is a guess by construction: OCR cannot tell a button from a
          // label. Everything is reported as text so nothing downstream infers
          // state that was never observed.
          role: 'StaticText',
          label: b.text,
          rect: { x: b.x, y: b.y, width: b.w, height: b.h },
        });
      });
    return { nodes, appName: 'iPhone (mirrored)' };
  }

  override async screenshot(opts: { path: string }): Promise<{ path: string }> {
    await helper('capture', opts.path);
    return { path: opts.path };
  }

  /** Centre of a ref's rect, or raw coordinates. */
  private point(target: PressTarget): { x: number; y: number } {
    if ('x' in target) return { x: target.x, y: target.y };
    const box = this.refs.get(target.ref);
    if (!box) throw new Error(`unknown ref ${target.ref} — take a fresh observe first`);
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }

  override async press(target: PressTarget): Promise<void> {
    const p = this.point(target);
    await helper('tap', String(p.x), String(p.y));
  }

  override async longPress(ref: string, durationMs = 800): Promise<void> {
    const p = this.point({ ref });
    await helper('longpress', String(p.x), String(p.y), String(durationMs));
  }

  override async typeText(text: string): Promise<void> {
    await helper('type', text);
  }

  override async fill(ref: string, text: string): Promise<void> {
    await this.press({ ref });
    await sleep(400);
    await helper('type', text);
  }

  override async pressKey(key: 'return'): Promise<void> {
    await helper('key', key);
  }

  /**
   * One scroll step.
   *
   * The magnitude matters more than anything else here: iPhone Mirroring drops
   * scroll events with small per-event deltas, so a gesture assembled from many
   * tiny steps silently does nothing at all. Measured on a real iPhone 17 Pro
   * Max — ~50px per event is ignored, 120px scrolls reliably.
   */
  override async scroll(direction: ScrollDirection): Promise<void> {
    const win = this.window ?? (await this.win());
    const step = 120;
    const [dx, dy] =
      direction === 'down'
        ? [0, -step]
        : direction === 'up'
          ? [0, step]
          : direction === 'right'
            ? [-step, 0]
            : [step, 0];
    await helper('scroll', String(dx), String(dy), String(win.w / 2), String(win.h / 2));
  }

  override async pan(x: number, y: number, dx: number, dy: number, durationMs = 350): Promise<void> {
    await helper('drag', String(x), String(y), String(x + dx), String(y + dy), String(durationMs));
  }

  override async waitForText(text: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const needle = text.toLowerCase();
    while (Date.now() < deadline) {
      const boxes = await helper<Box[]>('ocr');
      if (boxes.some((b) => b.text.toLowerCase().includes(needle))) return;
      await sleep(500);
    }
    throw new Error(`"${text}" did not appear within ${timeoutMs}ms`);
  }

  override async home(): Promise<void> {
    await helper('shortcut', 'home');
    await sleep(700);
  }

  /**
   * iOS has no hardware back button; apps use a nav-bar chevron or the
   * edge-swipe gesture. The gesture is the one that works app-independently.
   */
  override async back(): Promise<void> {
    const win = this.window ?? (await this.win());
    const y = win.h * 0.5;
    await helper('drag', '3', String(y), String(win.w * 0.6), String(y), '260');
    await sleep(500);
  }

  /** Launch via Spotlight, which is the only app launcher the window exposes. */
  override async openApp(opts: {
    app?: string | undefined;
    url?: string | undefined;
  }): Promise<OpenAppResult> {
    if (opts.url) {
      throw new Error('iPhone Mirroring cannot open URLs directly — open Safari and type the address');
    }
    const name = opts.app;
    if (!name) throw new Error('openApp needs an app name');
    // These waits are measured, not guessed. Spotlight needs ~2.5s after the
    // query to rank results; pressing Return sooner dismisses the sheet without
    // launching anything, which looks like the app simply failing to open.
    await helper('shortcut', 'home');
    await sleep(1500);
    await helper('shortcut', 'spotlight');
    await sleep(1500);
    await helper('type', name);
    await sleep(2500);
    await helper('key', 'return');
    await sleep(3000);
    return { appName: name };
  }

  override async systemAlert(_action: AlertAction): Promise<BackendAlertResult> {
    // Deliberately unsupported: without a real tree there is no way to tell an
    // alert from any other text, and guessing would silently accept dialogs.
    throw this.unsupported('alert');
  }

  override async closeSession(): Promise<void> {
    // Nothing to tear down — the phone keeps running and Mirroring stays open.
  }
}

/** Backend for the iPhone on your desk, driven through iPhone Mirroring. */
export function createMirrorBackend(): MirrorBackend {
  return new MirrorBackend();
}
