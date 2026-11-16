// Parse an Android `uiautomator dump` XML tree into phone-use SnapshotNodes.
//
// The dump is a flat-ish XML of <node> elements, each carrying the attributes
// Android exposes for accessibility: text, content-desc, resource-id, class,
// bounds, and the interactive flags (clickable, enabled, focused, …). This is
// the Android analogue of the iOS accessibility tree the other backends read.

import type { Rect, SnapshotNode } from '../device.ts';

/** `[x1,y1][x2,y2]` → a top-left Rect. Returns undefined if unparseable. */
export function parseBounds(bounds: string | undefined): Rect | undefined {
  const m = bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return undefined;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** `android.widget.Button` → `Button`; keeps a bare token as-is. */
function shortType(className: string | undefined): string | undefined {
  if (!className) return undefined;
  const tail = className.split('.').pop();
  return tail && tail.length > 0 ? tail : className;
}

/**
 * Normalise Android widget classes to the harness's canonical (iOS-named)
 * element types, so every layer above — inputFields(), setField(), the
 * interactive/editable sets in the SDK — works unchanged on Android.
 *
 * This is load-bearing: without it `type --field` reports "no editable text
 * field" on a real Android because `AutoCompleteTextView` never matches the
 * SDK's EDITABLE set ({SearchField, TextField, SecureTextField}). Measured on
 * a OnePlus Nord: the Settings search box is an AutoCompleteTextView.
 */
export function canonicalType(
  shortName: string | undefined,
  attrs: Record<string, string>,
): string | undefined {
  if (!shortName) return undefined;
  const isPassword = attrs.password === 'true';
  switch (shortName) {
    case 'EditText':
    case 'AutoCompleteTextView':
    case 'MultiAutoCompleteTextView':
    case 'SearchView':
    case 'TextInputEditText':
      return isPassword ? 'SecureTextField' : 'TextField';
    case 'Switch':
    case 'SwitchCompat':
    case 'CheckBox':
    case 'ToggleButton':
    case 'RadioButton':
      return 'Switch';
    case 'SeekBar':
      return 'Slider';
    case 'ImageButton':
      return 'Button';
    default:
      // Any clickable container is a tap target regardless of its widget
      // class. DeskClock's tab bar is clickable FrameLayouts with content-desc
      // ('Stopwatch', 'Timer'…): they rendered in observe but FrameLayout is
      // not a TAPPABLE role, so `tap "Stopwatch"` failed 16 straight runs on a
      // control that was on screen. Clickable → Button makes every such
      // control targetable by label.
      if (attrs.clickable === 'true') return 'Button';
      return shortName;
  }
}

const ATTR = /([\w:-]+)="([^"]*)"/g;

function attrs(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fragment.matchAll(ATTR)) {
    const key = m[1];
    const val = m[2];
    if (key !== undefined && val !== undefined) out[key] = decodeEntities(val);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

const isTrue = (v: string | undefined): boolean => v === 'true';

export type ParsedHierarchy = {
  nodes: SnapshotNode[];
  /** ref → rect, so a later press-by-ref can tap the element's centre. */
  rects: Map<string, Rect>;
  /** The package the tree belongs to (frontmost app), if the dump carries one. */
  packageName?: string;
};

/**
 * Parse a uiautomator XML dump. Each <node> becomes a SnapshotNode with a
 * fresh `@aN` ref. When `interactiveOnly`, keep only nodes that are actually
 * actionable (clickable / long-clickable / a focusable field) or that carry a
 * label — the rest is layout scaffolding an agent should not try to tap.
 */
export function parseHierarchy(xml: string, opts: { interactiveOnly?: boolean } = {}): ParsedHierarchy {
  const all: { node: SnapshotNode; keep: boolean }[] = [];
  let packageName: string | undefined;

  // Match both self-closing <node ... /> and opening <node ...> tags; the tree
  // is walked flat, which is enough — geometry lives in bounds, not nesting.
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const fragment = m[1];
    if (fragment === undefined) continue;
    const a = attrs(fragment);
    if (!packageName && a.package) packageName = a.package;

    const label = a.text || a['content-desc'] || undefined;
    const clickable = isTrue(a.clickable) || isTrue(a['long-clickable']);
    const focusableField = isTrue(a.focusable) && (label !== undefined || isTrue(a.editable));
    const rect = parseBounds(a.bounds);

    const node: SnapshotNode = {
      ref: '', // assigned after filtering so refs stay dense
      type: canonicalType(shortType(a.class), a),
      role: canonicalType(shortType(a.class), a),
      ...(label !== undefined ? { label } : {}),
      ...(a.text && a.text !== label ? { value: a.text } : {}),
      ...(a['resource-id'] ? { identifier: a['resource-id'] } : {}),
      enabled: a.enabled ? isTrue(a.enabled) : true,
      selected: isTrue(a.selected),
      focused: isTrue(a.focused),
      ...(rect ? { rect } : {}),
      // A disabled control can't be actioned; surface why, mirroring iOS.
      ...(a.enabled && !isTrue(a.enabled) ? { interactionBlocked: 'disabled' } : {}),
    };
    all.push({ node, keep: !opts.interactiveOnly || clickable || focusableField || label !== undefined });
  }

  // Absorb on the FULL tree (the Application root's geometry anchors the
  // scaffolding guard), then filter and number the survivors.
  const absorbed = absorbRowLabels(all.map((e) => e.node));

  const nodes: SnapshotNode[] = [];
  const rects = new Map<string, Rect>();
  let index = 0;
  for (const { node, keep } of all) {
    if (!keep) continue;
    // The row now carries its title; listing the title text again under it
    // is the same thing twice ("Button Network & internet" + "TextView
    // Network & internet"). Subtitles are not absorbed and stay.
    if (opts.interactiveOnly && absorbed.has(node)) continue;
    index += 1;
    node.ref = `@a${index}`;
    if (node.rect) rects.set(node.ref, node.rect);
    nodes.push(node);
  }

  return { nodes, rects, ...(packageName ? { packageName } : {}) };
}

const INTERACTIVE_TYPES = new Set(['Button', 'Switch', 'TextField', 'SecureTextField', 'Slider']);

/**
 * Android list rows are typically an unlabeled clickable container wrapping
 * passive TextViews that carry the visible text (Settings' "Network &
 * internet" row is a bare clickable frame plus two TextViews). The resolver
 * only matches interactive elements, so without help `tap "<row text>"` finds
 * nothing — the same failure mode the clickable→Button mapping fixed for
 * DeskClock's tabs. Give each unlabeled clickable node the first passive
 * label drawn fully inside it; document order in a uiautomator dump nests
 * children right after their parent, so the scan stops at the first node
 * outside the container's bounds.
 */
function absorbRowLabels(nodes: SnapshotNode[]): Set<SnapshotNode> {
  const absorbed = new Set<SnapshotNode>();
  // The full tree always leads with the root's geometry — its bottom edge is
  // the screen height.
  let treeBottom = 0;
  for (const n of nodes) {
    if (n.rect) treeBottom = Math.max(treeBottom, n.rect.y + n.rect.height);
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.label !== undefined || node.type !== 'Button' || !node.rect) continue;
    // Rows and tiles are short; a clickable container spanning much of the
    // screen is scaffolding whose first text is not its name.
    if (treeBottom && node.rect.height > treeBottom * 0.25) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const donor = nodes[j]!;
      if (!donor.rect || !containsRect(node.rect, donor.rect)) break;
      if (donor.label !== undefined && !INTERACTIVE_TYPES.has(donor.type ?? '')) {
        node.label = donor.label;
        absorbed.add(donor);
        break;
      }
    }
  }

  // Settings-style switch rows put the text on a passive TextView and leave
  // the Switch widget itself unlabeled — so `toggle "<name>"` can't find the
  // switch. Name each unlabeled Switch after the nearest passive label in its
  // horizontal band (the row text sits to the switch's left).
  for (const node of nodes) {
    if (node.label !== undefined || node.type !== 'Switch' || !node.rect) continue;
    const bandTop = node.rect.y;
    const bandBottom = node.rect.y + node.rect.height;
    let best: SnapshotNode | undefined;
    for (const donor of nodes) {
      if (donor === node || donor.label === undefined || !donor.rect) continue;
      if (INTERACTIVE_TYPES.has(donor.type ?? '')) continue;
      const overlap =
        Math.min(bandBottom, donor.rect.y + donor.rect.height) - Math.max(bandTop, donor.rect.y);
      if (overlap < donor.rect.height / 2) continue;
      if (donor.rect.x >= node.rect.x) continue; // row text sits left of its switch
      if (!best || donor.rect.x < best.rect!.x) best = donor; // leftmost = the title column
    }
    if (best?.label) node.label = best.label;
  }
  return absorbed;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
