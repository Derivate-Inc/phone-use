// Terminal styling for the CLI — zero deps (supply-chain posture per doc 19).
// Everything degrades to plain text when stdout is not a TTY or NO_COLOR is
// set, so agents piping `phone-use …` output always get clean, parseable text;
// humans at a terminal get the pretty version. Truecolor with a 256/16 UX is
// not attempted: every modern terminal this targets (Terminal.app, iTerm2,
// VS Code, Ghostty) speaks 24-bit.

const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const esc = (codes: string, s: string) => (enabled ? `\x1b[${codes}m${s}\x1b[0m` : s);

export const bold = (s: string): string => esc('1', s);
export const dim = (s: string): string => esc('2', s);
export const italic = (s: string): string => esc('3', s);

type Rgb = [number, number, number];
const fg = ([r, g, b]: Rgb, s: string) => esc(`38;2;${r};${g};${b}`, s);

// The palette: violet → cyan is the wordmark gradient; the rest are semantic.
export const VIOLET: Rgb = [139, 128, 250];
export const CYAN: Rgb = [86, 197, 232];
export const GREEN: Rgb = [82, 196, 121];
export const RED: Rgb = [235, 100, 104];
export const AMBER: Rgb = [229, 172, 78];
export const GRAY: Rgb = [140, 146, 160];

export const accent = (s: string): string => fg(VIOLET, s);
export const ok = (s: string): string => fg(GREEN, s);
export const err = (s: string): string => fg(RED, s);
export const warn = (s: string): string => fg(AMBER, s);
export const muted = (s: string): string => fg(GRAY, s);
export const info = (s: string): string => fg(CYAN, s);

/** Per-character linear gradient — the wordmark treatment. */
export function gradient(s: string, from: Rgb = VIOLET, to: Rgb = CYAN): string {
  if (!enabled) return s;
  const chars = [...s];
  const n = Math.max(chars.length - 1, 1);
  return chars
    .map((c, i) => {
      const t = i / n;
      const mix = from.map((f, k) => Math.round(f + ((to[k] as number) - f) * t)) as Rgb;
      return fg(mix, c);
    })
    .join('');
}

/**
 * Colorize a verb result for terminal display. Pure decoration over the plain
 * renderer string (never applied when piped): status glyphs get semantic
 * colors, @refs cyan, [roles] dimmed — observation output reads at a glance.
 */
export function prettify(out: string): string {
  if (!enabled) return out;
  return out
    .split('\n')
    .map((line) => {
      if (line.startsWith('⛔')) return err(bold(line));
      if (line.startsWith('⏸')) return warn(line);
      if (line.startsWith('ERROR')) return err(line);
      if (line.startsWith('✓')) return ok(line);
      if (line.startsWith('✗')) return err(line);
      return line
        .replace(/@e\d+/g, (m) => info(m))
        .replace(/\[([A-Za-z]+)\]/g, (m) => dim(m))
        .replace(/^(App|Screen|Screenshot|Status):/g, (m) => accent(m));
    })
    .join('\n');
}
