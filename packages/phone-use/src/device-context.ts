import type { ActionEvidence } from '@phone-use/sdk';
import { DeviceCore } from '@phone-use/sdk';
import sharp from 'sharp';
import { annotate, type Box } from './annotate.ts';
import { currentExecution } from './execution-context.ts';
import { currentTraceSession, traceActive } from './trace-session.ts';

// ---------------------------------------------------------------------------
// DeviceContext: the harness layer over the SDK's
// DeviceCore. The observe/resolve/act brain lives in @phone-use/sdk (observe.ts);
// this subclass keeps only what needs Bun, sharp, or the annotate renderer —
// zoom-on-region, the fast simctl JPEG capture, the interactive cursor, and
// the live-viewer state feed. driver.ts remains the process-global
// compatibility facade over a lazy default instance.
// ---------------------------------------------------------------------------

// Re-exports so driver.ts's import surface stays byte-identical.
export type {
  ActionEvidence,
  AlertOutcome,
  Observation,
  Resolution,
  ResolveOpts,
  UiElement,
} from '@phone-use/sdk';
export { describeError, labelMatches } from '@phone-use/sdk';

export type CursorFrame = {
  path: string;
  cursor: { x: number; y: number };
  hoveredRef?: string | undefined;
  note: string;
};

function normRef(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
}

// Live overlay state (point space) pushed to the viewer so the cursor + boxes
// render/animate client-side, decoupled from the screen frame rate.
export type LiveState = {
  viewport: { width: number; height: number };
  cursor: { x: number; y: number };
  hoveredRef?: string | undefined;
  boxes: { ref: string; x: number; y: number; width: number; height: number; interactive: boolean }[];
  pulse?: { x: number; y: number; at: number } | undefined;
};

// Zoom-on-region transform (see zoomRegion): magnified-pixel -> screen-point.
type ZoomContext = { originX: number; originY: number; scaleInv: number };

export class DeviceContext extends DeviceCore {
  private lastZoom: ZoomContext | undefined;
  // Interactive cursor model (desktop-computer-use style): a virtual pointer
  // with move-then-click; state persists across MCP tool calls in the
  // long-running server.
  private cursor = { x: 195, y: 420 };
  private hoveredRef: string | undefined;
  private lastPulse: { x: number; y: number; at: number } | undefined;
  private readonly stateListeners = new Set<(s: LiveState) => void>();
  private bootedUdidCache: string | undefined;

  // The core's snapshot cache just updated — push fresh overlay state to the
  // live viewer, and feed the trace artifact a tree snapshot
  // + a filmstrip frame when a session is recording.
  /**
   * EVERY node in the current cache, unfiltered — including containers with
   * no label (a WebView, a FlutterView) that interactiveElements() drops. The
   * blind-tree detector needs those: a screen that is *only* app chrome around
   * an opaque container reads as fully "interactive" through the tappable
   * filter and blind through this one.
   */
  allElements(): {
    role: string;
    label: string;
    rect?: { x: number; y: number; width: number; height: number } | undefined;
  }[] {
    return this.cachedNodes.map((n) => ({
      role: n.role ?? n.type ?? '',
      label: (n.label ?? n.identifier ?? '').trim(),
      rect: n.rect ? { x: n.rect.x, y: n.rect.y, width: n.rect.width, height: n.rect.height } : undefined,
    }));
  }

  protected override onCacheUpdated(): void {
    this.publishState();
    if (!traceActive()) return;
    const session = currentTraceSession();
    session?.captureTree({
      app: this.lastApp.app,
      bundleId: this.lastApp.bundleId,
      viewport: this.cachedViewport,
      nodes: this.cachedNodes,
    });
    // Fast simctl JPEG; on hosts without xcrun (or a booted sim) this resolves
    // null and records nothing — never throws.
    session?.captureFrame(() => this.captureFastJpeg().catch(() => null));
  }

  private async pngPixelSize(path: string): Promise<{ w: number; h: number }> {
    const out = await new Response(
      Bun.spawn(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path]).stdout,
    ).text();
    const w = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
    const h = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0);
    return { w, h };
  }

  private async sips(args: string[]): Promise<void> {
    const proc = Bun.spawn(['sips', ...args], { stderr: 'pipe' });
    if ((await proc.exited) !== 0) throw new Error(`sips failed: ${await new Response(proc.stderr).text()}`);
  }

  // Zoom-on-region (ported from cua's zoom.rs): crop a screen region, pad it,
  // magnify to a legible size, and remember the transform. The model then reads
  // coordinates off the magnified image and pressInZoom translates them back to
  // real screen points — the way desktop CUAs hit small/dense targets (keyboard
  // keys, map pins, toolbar icons) that a full-screen tap would miss.
  async zoomRegion(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    outPath: string,
  ): Promise<{ path: string; note: string }> {
    const full = `${outPath}.full.png`;
    await this.backend.screenshot({ path: full });

    // Device scale: screenshot is in pixels, action/observe coords are in points.
    const px = await this.pngPixelSize(full);
    const viewport = await this.currentViewport();
    const scale = viewport.width > 0 ? px.w / viewport.width : 1;

    // 20% padding around the requested region, clamped to the screen.
    const padX = (x2 - x1) * 0.2;
    const padY = (y2 - y1) * 0.2;
    const rx1 = Math.max(0, x1 - padX);
    const ry1 = Math.max(0, y1 - padY);
    const rx2 = Math.min(viewport.width, x2 + padX);
    const ry2 = Math.min(viewport.height, y2 + padY);

    const cropXpx = Math.round(rx1 * scale);
    const cropYpx = Math.round(ry1 * scale);
    const cropWpx = Math.round((rx2 - rx1) * scale);
    const cropHpx = Math.round((ry2 - ry1) * scale);

    await this.sips([
      '-c',
      String(cropHpx),
      String(cropWpx),
      '--cropOffset',
      String(cropYpx),
      String(cropXpx),
      full,
      '--out',
      outPath,
    ]);

    // Magnify to ~600px wide for legibility; record the inverse transform.
    const target = 600;
    const factor = cropWpx > 0 ? target / cropWpx : 1;
    await this.sips(['-Z', String(Math.max(target, cropWpx)), outPath]);
    const zoomed = await this.pngPixelSize(outPath);

    // magnified-pixel -> screen-point: divide by (factor*scale), add region origin.
    this.lastZoom = { originX: rx1, originY: ry1, scaleInv: 1 / (factor * scale) };

    return {
      path: outPath,
      note: `Zoomed region screen-points (${Math.round(rx1)},${Math.round(ry1)})–(${Math.round(rx2)},${Math.round(ry2)}), image ${zoomed.w}x${zoomed.h}. Read a target's pixel position in this image and call press_in_zoom with it.`,
    };
  }

  async pressInZoom(zx: number, zy: number): Promise<ActionEvidence> {
    if (!this.lastZoom) throw new Error('No zoom region is active. Call zoom_region first.');
    const x = Math.round(this.lastZoom.originX + zx * this.lastZoom.scaleInv);
    const y = Math.round(this.lastZoom.originY + zy * this.lastZoom.scaleInv);
    return this.pressAt(x, y);
  }

  getCursor(): { x: number; y: number } {
    return { ...this.cursor };
  }

  private boxesFromCache(): Box[] {
    const out: Box[] = [];
    for (const n of this.cachedNodes) {
      if (!n.ref || !n.rect) continue;
      out.push({
        ref: normRef(n.ref),
        x: n.rect.x,
        y: n.rect.y,
        width: n.rect.width,
        height: n.rect.height,
        kind: n.type ?? n.role ?? 'Other',
      });
    }
    return out;
  }

  // --- Fast raw capture for the live stream --------------------------------
  // Direct `simctl io screenshot` is ~4x faster than the driver's screenshot
  // (~110ms vs ~530ms), so the live viewer captures raw JPEG frames this way
  // and overlays the cursor client-side, keeping the stream smooth.
  private async bootedUdid(): Promise<string | undefined> {
    // Never use a host's unrelated booted simulator for a pinned/remote session.
    if (
      currentExecution() ||
      this.backend.backendName !== 'xctest' ||
      process.env.PHONE_USE_SANDBOX_URL ||
      process.env.PHONE_USE_RUNNER_URL
    )
      return undefined;
    if (this.bootedUdidCache) return this.bootedUdidCache;
    const pinned = (this.backend as { udid?: string }).udid;
    if (pinned && pinned !== 'booted') {
      this.bootedUdidCache = pinned;
      return pinned;
    }
    const out = await new Response(
      Bun.spawn(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j']).stdout,
    ).text();
    try {
      const data = JSON.parse(out) as { devices: Record<string, Array<{ udid: string; state: string }>> };
      if (
        Object.values(data.devices)
          .flat()
          .filter((d) => d.state === 'Booted').length !== 1
      )
        return undefined;
      for (const list of Object.values(data.devices)) {
        const dev = list.find((d) => d.state === 'Booted');
        if (dev) {
          this.bootedUdidCache = dev.udid;
          return this.bootedUdidCache;
        }
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  async captureFastJpeg(): Promise<Buffer | null> {
    const udid = await this.bootedUdid();
    if (!udid) return null;
    const proc = Bun.spawn(['xcrun', 'simctl', 'io', udid, 'screenshot', '--type=jpeg', '-'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    return buf.length > 0 ? buf : null;
  }

  onState(fn: (s: LiveState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  getLiveState(): LiveState {
    return {
      viewport: this.cachedViewport,
      cursor: this.cursor,
      hoveredRef: this.hoveredRef,
      boxes: this.liveBoxes(),
      pulse: this.lastPulse,
    };
  }

  private liveBoxes(): LiveState['boxes'] {
    const interactive = new Set([
      'Button',
      'Link',
      'Cell',
      'TextField',
      'SecureTextField',
      'SearchField',
      'Switch',
      'Slider',
      'MenuItem',
      'Tab',
    ]);
    const out: LiveState['boxes'] = [];
    for (const n of this.cachedNodes) {
      if (!n.ref || !n.rect) continue;
      if (n.rect.width >= this.cachedViewport.width && n.rect.height >= this.cachedViewport.height) continue;
      out.push({
        ref: normRef(n.ref),
        x: n.rect.x,
        y: n.rect.y,
        width: n.rect.width,
        height: n.rect.height,
        interactive: interactive.has(n.type ?? n.role ?? ''),
      });
    }
    return out;
  }

  private publishState(): void {
    const s = this.getLiveState();
    for (const fn of this.stateListeners) fn(s);
  }

  private async renderFrame(
    outPath: string,
    opts: { pulse?: { x: number; y: number } } = {},
  ): Promise<string> {
    // Fast path: raw JPEG via simctl (~110ms). Fall back to the backend
    // screenshot if the fast path is unavailable (e.g. real device, not a
    // simulator).
    const base = `${outPath}.base.jpg`;
    const jpeg = await this.captureFastJpeg();
    if (jpeg) await Bun.write(base, jpeg);
    else await this.backend.screenshot({ path: base });
    const meta = await sharp(base).metadata();
    const scale =
      this.cachedViewport.width > 0
        ? (meta.width ?? this.cachedViewport.width) / this.cachedViewport.width
        : 1;
    const path = await annotate(base, outPath, {
      scale,
      boxes: this.boxesFromCache(),
      cursor: this.cursor,
      highlightRef: this.hoveredRef,
      pulse: opts.pulse,
    });
    return path;
  }

  async moveCursorToRef(ref: string, outPath: string): Promise<CursorFrame> {
    await this.ensureCache();
    const node = this.findNode(ref);
    if (!node?.rect) {
      this.hoveredRef = undefined;
      throw new Error(
        `No element ${normRef(ref)} in the current view. Call observe first to refresh element refs.`,
      );
    }
    this.cursor = {
      x: Math.round(node.rect.x + node.rect.width / 2),
      y: Math.round(node.rect.y + node.rect.height / 2),
    };
    this.hoveredRef = normRef(ref);
    this.publishState();
    const path = await this.renderFrame(outPath);
    return {
      path,
      cursor: this.cursor,
      hoveredRef: this.hoveredRef,
      note: `Cursor on ${this.hoveredRef} ${node.label ? JSON.stringify(node.label) : `[${node.type ?? 'element'}]`} at (${this.cursor.x}, ${this.cursor.y}). Call click to tap it.`,
    };
  }

  async moveCursorToPoint(x: number, y: number, outPath: string): Promise<CursorFrame> {
    await this.ensureCache();
    this.cursor = { x: Math.round(x), y: Math.round(y) };
    this.hoveredRef = undefined;
    this.publishState();
    const path = await this.renderFrame(outPath);
    return {
      path,
      cursor: this.cursor,
      note: `Cursor at (${this.cursor.x}, ${this.cursor.y}). Call click to tap here.`,
    };
  }

  async clickCursor(outPath: string): Promise<CursorFrame & { evidence: ActionEvidence }> {
    // Prefer the semantic ref under the cursor (more robust than a raw pixel
    // tap); fall back to a coordinate tap when the cursor was moved to a bare
    // point.
    this.lastPulse = { x: this.cursor.x, y: this.cursor.y, at: Date.now() };
    this.publishState();
    // press/pressAt already re-snapshot the cache to the post-tap state.
    const evidence = this.hoveredRef
      ? await this.press(this.hoveredRef)
      : await this.pressAt(this.cursor.x, this.cursor.y);
    const pulse = { ...this.cursor };
    const path = await this.renderFrame(outPath, { pulse });
    const target = this.hoveredRef ?? `(${this.cursor.x}, ${this.cursor.y})`;
    return {
      path,
      cursor: this.cursor,
      hoveredRef: this.hoveredRef,
      evidence,
      note: `Clicked ${target}. ${evidence.detail ?? ''}`.trim(),
    };
  }

  async renderCurrentFrame(outPath: string): Promise<string> {
    await this.ensureCache();
    return this.renderFrame(outPath);
  }
}
