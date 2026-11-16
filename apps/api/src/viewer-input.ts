import { fileURLToPath } from 'node:url';

type Point = { x: number; y: number };
export type ViewerGesture = { start: Point; end?: Point; durationMs?: number; width: number; height: number };
export type ViewerInput = ViewerGesture | { button: 'home' | 'return' } | { text: string };
export function parseViewerInput(value: unknown): ViewerInput {
  const input = value as ViewerInput | null;
  if (!input || typeof input !== 'object') throw new Error('Invalid viewer input');
  if ('button' in input) {
    if (input.button !== 'home' && input.button !== 'return') throw new Error('Invalid viewer button');
    return { button: input.button };
  }
  if ('text' in input) {
    if (typeof input.text !== 'string' || !input.text.length || input.text.length > 2000)
      throw new Error('Invalid viewer text');
    return { text: input.text };
  }
  const point = (p: Point | undefined) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  if (!point(input.start) || (input.end !== undefined && !point(input.end))
    || !Number.isInteger(input.width) || input.width < 1 || input.width > 10000
    || !Number.isInteger(input.height) || input.height < 1 || input.height > 10000
    || (input.durationMs !== undefined && (!Number.isFinite(input.durationMs)
      || input.durationMs < 50 || input.durationMs > 2000))) throw new Error('Invalid viewer gesture');
  // Only forward validated fields to the native bridge.
  return { start: { x: input.start.x, y: input.start.y }, width: input.width, height: input.height,
    ...(input.end ? { end: { x: input.end.x, y: input.end.y } } : {}),
    durationMs: input.durationMs ?? 300 };
}

async function run(command: string[], input: string) {
  const proc = Bun.spawn(command, { stdin: new TextEncoder().encode(input), stdout: 'ignore', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 10000);
  try {
    const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(error.trim().slice(0, 500) || 'Simulator input timed out');
  } finally { clearTimeout(timer); }
}

export class ViewerInputs {
  private readonly busy = new Set<string>();
  constructor(private readonly execute = run) {}
  async send(deviceId: string, value: unknown) {
    const input = parseViewerInput(value);
    if (this.busy.has(deviceId)) throw new Error('Another viewer input is in progress');
    this.busy.add(deviceId);
    try {
      let native: ViewerGesture | { button: string } = input as ViewerGesture;
      if ('text' in input) {
        await this.execute(['xcrun', 'simctl', 'pbcopy', deviceId], input.text);
        native = { button: 'paste' };
      }
      const binary = process.env.PHONE_USE_INPUT_BIN ?? fileURLToPath(new URL('../native/phone-input', import.meta.url));
      await this.execute([binary, deviceId], JSON.stringify(native));
    } finally { this.busy.delete(deviceId); }
  }
}
