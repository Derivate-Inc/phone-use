import sharp from 'sharp';

export type Box = {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
};

export type AnnotateOptions = {
  scale: number; // screenshot pixels per screen point
  boxes: Box[];
  cursor?: { x: number; y: number };
  highlightRef?: string | undefined;
  pulse?: { x: number; y: number } | undefined;
};

const INTERACTIVE = new Set([
  'Button',
  'Link',
  'Cell',
  'TextField',
  'SecureTextField',
  'SearchField',
  'Switch',
  'Slider',
  'Image',
  'MenuItem',
  'Tab',
  'StaticText',
]);

// A classic arrow pointer whose tip sits at (0,0); we translate it to the
// cursor position. White fill + dark edge + shadow so it reads on any UI.
const CURSOR_PATH = 'M0,0 L0,18 L5,13.5 L8.5,21 L11.5,19.6 L8,12.3 L14,12.3 Z';

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

export async function annotate(
  baseScreenshotPath: string,
  outPath: string,
  opts: AnnotateOptions,
): Promise<string> {
  const meta = await sharp(baseScreenshotPath).metadata();
  const W = meta.width ?? 390;
  const H = meta.height ?? 844;
  const s = opts.scale;

  const parts: string[] = [];

  // Element boxes — interactive elements get a thin cyan outline + ref chip.
  // Deduplicate near-identical boxes to reduce clutter on dense screens.
  const seen = new Set<string>();
  for (const b of opts.boxes) {
    if (!INTERACTIVE.has(b.kind)) continue;
    if (b.width <= 0 || b.height <= 0) continue;
    if (b.width * s >= W && b.height * s >= H) continue; // skip full-screen containers
    const x = Math.round(b.x * s);
    const y = Math.round(b.y * s);
    const w = Math.round(b.width * s);
    const h = Math.round(b.height * s);
    const key = `${x},${y},${w},${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const highlight = b.ref === opts.highlightRef;
    const stroke = highlight ? 'rgb(255,90,40)' : 'rgba(0,150,255,0.55)';
    const sw = highlight ? 3 : 1.25;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${highlight ? 'rgba(255,90,40,0.10)' : 'none'}" stroke="${stroke}" stroke-width="${sw}"/>`,
    );
    const label = b.ref.replace(/^@/, '');
    const chipW = 12 + label.length * 7;
    parts.push(
      `<rect x="${x}" y="${Math.max(0, y - 15)}" width="${chipW}" height="15" rx="3" fill="${highlight ? 'rgb(255,90,40)' : 'rgb(0,120,220)'}"/>` +
        `<text x="${x + 4}" y="${Math.max(11, y - 4)}" font-size="11" font-family="Helvetica,Arial" fill="white">${esc(label)}</text>`,
    );
  }

  // Click pulse — concentric rings at the tap point.
  if (opts.pulse) {
    const px = Math.round(opts.pulse.x * s);
    const py = Math.round(opts.pulse.y * s);
    parts.push(
      `<circle cx="${px}" cy="${py}" r="22" fill="none" stroke="rgba(255,90,40,0.45)" stroke-width="2"/>` +
        `<circle cx="${px}" cy="${py}" r="12" fill="none" stroke="rgba(255,90,40,0.85)" stroke-width="2.5"/>` +
        `<circle cx="${px}" cy="${py}" r="3" fill="rgb(255,90,40)"/>`,
    );
  }

  // Cursor pointer — tip at the current position, scaled up for visibility.
  if (opts.cursor) {
    const cx = Math.round(opts.cursor.x * s);
    const cy = Math.round(opts.cursor.y * s);
    const k = 1.5 * s;
    parts.push(
      `<g transform="translate(${cx},${cy}) scale(${k})">` +
        `<path d="${CURSOR_PATH}" fill="rgba(0,0,0,0.35)" transform="translate(0.8,0.8)"/>` +
        `<path d="${CURSOR_PATH}" fill="white" stroke="rgb(20,20,20)" stroke-width="1.1" stroke-linejoin="round"/>` +
        `</g>`,
    );
  }

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`,
  );

  await sharp(baseScreenshotPath)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toFile(outPath);
  return outPath;
}
