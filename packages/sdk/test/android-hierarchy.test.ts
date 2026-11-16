import { describe, expect, it } from 'vitest';
import { isPrintableAscii } from '../src/backends/android.ts';
import { canonicalType, parseBounds, parseHierarchy } from '../src/backends/android-hierarchy.ts';

// A trimmed but real-shaped uiautomator dump: a clickable button with text, a
// disabled field, and a layout node with neither text nor actionability.
const DUMP = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][1080,2340]">
    <node index="0" text="Sign in" resource-id="com.example.app:id/login" class="android.widget.Button" package="com.example.app" clickable="true" enabled="true" focused="false" bounds="[40,300][1040,420]" />
    <node index="1" text="" content-desc="Email" class="android.widget.EditText" package="com.example.app" clickable="true" focusable="true" enabled="true" bounds="[40,140][1040,260]" />
    <node index="2" class="android.widget.LinearLayout" package="com.example.app" clickable="false" bounds="[0,500][1080,600]" />
  </node>
</hierarchy>`;

describe('parseBounds', () => {
  it('reads [x1,y1][x2,y2] into a top-left rect', () => {
    expect(parseBounds('[40,300][1040,420]')).toEqual({ x: 40, y: 300, width: 1000, height: 120 });
  });
  it('returns undefined for junk', () => {
    expect(parseBounds('nonsense')).toBeUndefined();
    expect(parseBounds(undefined)).toBeUndefined();
  });
});

describe('parseHierarchy', () => {
  it('maps nodes to labelled SnapshotNodes with rects and package', () => {
    const { nodes, rects, packageName } = parseHierarchy(DUMP);
    expect(packageName).toBe('com.example.app');
    const button = nodes.find((n) => n.label === 'Sign in');
    expect(button).toBeDefined();
    expect(button?.type).toBe('Button');
    expect(button?.identifier).toBe('com.example.app:id/login');
    expect(button?.rect).toEqual({ x: 40, y: 300, width: 1000, height: 120 });
    // the ref resolves back to a rect for press-by-ref
    expect(rects.get(button?.ref ?? '')).toEqual(button?.rect);
    // content-desc becomes the label when text is empty
    expect(nodes.some((n) => n.label === 'Email')).toBe(true);
  });

  it('interactiveOnly drops label-less, non-actionable layout nodes', () => {
    const all = parseHierarchy(DUMP).nodes;
    const interactive = parseHierarchy(DUMP, { interactiveOnly: true }).nodes;
    expect(all.some((n) => n.type === 'LinearLayout')).toBe(true);
    expect(interactive.some((n) => n.type === 'LinearLayout')).toBe(false);
    // the button and the field survive
    expect(interactive.some((n) => n.label === 'Sign in')).toBe(true);
    expect(interactive.some((n) => n.label === 'Email')).toBe(true);
  });

  it('assigns stable sequential refs', () => {
    const { nodes } = parseHierarchy(DUMP);
    expect(nodes[0]?.ref).toBe('@a1');
    expect(new Set(nodes.map((n) => n.ref)).size).toBe(nodes.length);
  });
});

describe('typeText segmentation (newline / backspace conventions)', () => {
  // The backend splits on \n → ENTER and \b → DEL before choosing ASCII vs
  // Unicode delivery. Exercise that pure splitting logic the same way.
  const segment = (text: string) => text.split('\n').map((line) => line.split('\b'));

  it('splits lines and backspaces into chunks', () => {
    expect(segment('ab\ncd')).toEqual([['ab'], ['cd']]);
    expect(segment('ab\bc')).toEqual([['ab', 'c']]);
  });
  it('routes ASCII to input text and non-ASCII to the IME path', () => {
    expect(isPrintableAscii('hello world 123')).toBe(true);
    expect(isPrintableAscii('café')).toBe(false);
    expect(isPrintableAscii('日本')).toBe(false);
    expect(isPrintableAscii('🎉')).toBe(false);
  });
});

describe('canonicalType (Android widgets → harness element types)', () => {
  it('maps text inputs to TextField so inputFields()/setField() find them', () => {
    expect(canonicalType('AutoCompleteTextView', {})).toBe('TextField');
    expect(canonicalType('EditText', {})).toBe('TextField');
    expect(canonicalType('SearchView', {})).toBe('TextField');
  });
  it('marks password fields as SecureTextField', () => {
    expect(canonicalType('EditText', { password: 'true' })).toBe('SecureTextField');
  });
  it('maps toggles and sliders', () => {
    expect(canonicalType('SwitchCompat', {})).toBe('Switch');
    expect(canonicalType('CheckBox', {})).toBe('Switch');
    expect(canonicalType('SeekBar', {})).toBe('Slider');
    expect(canonicalType('ImageButton', {})).toBe('Button');
  });
  it('leaves everything else as its short class name', () => {
    expect(canonicalType('TextView', {})).toBe('TextView');
    expect(canonicalType('RecyclerView', {})).toBe('RecyclerView');
  });
  it('a parsed EditText node comes out as a TextField', () => {
    const xml = `<hierarchy><node text="" class="android.widget.EditText" package="a" bounds="[0,0][100,50]" clickable="true" focusable="true" enabled="true"/></hierarchy>`;
    expect(parseHierarchy(xml).nodes[0]?.type).toBe('TextField');
  });
});

describe('absorbRowLabels (unlabeled clickable rows take their inner text)', () => {
  const row = (y: number, text: string) =>
    `<node text="" class="android.widget.LinearLayout" package="s" bounds="[0,${y}][1080,${y + 214}]" clickable="true" enabled="true">` +
    `<node text="${text}" class="android.widget.TextView" package="s" bounds="[126,${y + 40}][558,${y + 115}]" clickable="false" enabled="true"/>` +
    `</node>`;
  const screen = (inner: string) =>
    `<hierarchy><node text="" class="android.widget.FrameLayout" package="s" bounds="[0,0][1080,2400]" clickable="false" enabled="true">${inner}</node></hierarchy>`;

  it('a Settings-style row resolves by its TextView text', () => {
    const { nodes } = parseHierarchy(screen(row(299, 'Network &amp; internet')), { interactiveOnly: true });
    const tappable = nodes.find((n) => n.type === 'Button');
    expect(tappable?.label).toBe('Network & internet');
  });

  it("each row absorbs its own label, not a neighbour row's", () => {
    const { nodes } = parseHierarchy(screen(row(299, 'Battery') + row(513, 'Storage')), {
      interactiveOnly: true,
    });
    const labels = nodes.filter((n) => n.type === 'Button').map((n) => n.label);
    expect(labels).toEqual(['Battery', 'Storage']);
  });

  it('lists a row once: the absorbed title text is not repeated, the subtitle stays', () => {
    const rowWithSubtitle =
      `<node text="" class="android.widget.LinearLayout" package="s" bounds="[0,299][1080,513]" clickable="true" enabled="true">` +
      `<node text="Network &amp; internet" class="android.widget.TextView" package="s" bounds="[126,339][558,414]" clickable="false" enabled="true"/>` +
      `<node text="Mobile, Wi-Fi, hotspot" class="android.widget.TextView" package="s" bounds="[126,414][558,470]" clickable="false" enabled="true"/>` +
      `</node>`;
    const interactive = parseHierarchy(screen(rowWithSubtitle), { interactiveOnly: true }).nodes;
    expect(interactive.map((n) => `${n.type}:${n.label}`)).toEqual([
      'Button:Network & internet',
      'TextView:Mobile, Wi-Fi, hotspot',
    ]);
    // The full tree still has every node.
    const full = parseHierarchy(screen(rowWithSubtitle)).nodes;
    expect(full.filter((n) => n.label === 'Network & internet')).toHaveLength(2);
  });

  it('a labeled clickable keeps its own label', () => {
    const xml = screen(
      `<node text="" content-desc="Wi-Fi" class="android.widget.FrameLayout" package="s" bounds="[0,299][1080,513]" clickable="true" enabled="true">` +
        `<node text="Internet" class="android.widget.TextView" package="s" bounds="[126,339][558,414]" clickable="false" enabled="true"/></node>`,
    );
    const { nodes } = parseHierarchy(xml, { interactiveOnly: true });
    expect(nodes.find((n) => n.type === 'Button')?.label).toBe('Wi-Fi');
  });

  it('does not absorb from another interactive element', () => {
    const xml = screen(
      `<node text="" class="android.widget.LinearLayout" package="s" bounds="[0,299][1080,513]" clickable="true" enabled="true">` +
        `<node text="ON" class="android.widget.Switch" package="s" bounds="[880,320][1068,500]" clickable="true" enabled="true"/></node>`,
    );
    const { nodes } = parseHierarchy(xml, { interactiveOnly: true });
    const container = nodes.find((n) => n.type === 'Button' && n.rect?.width === 1080);
    expect(container?.label).toBeUndefined();
  });

  it('a tall scaffolding container does not steal the first text on screen', () => {
    const xml = screen(
      `<node text="" class="android.widget.ScrollView" package="s" bounds="[0,0][1080,2200]" clickable="true" enabled="true">` +
        `<node text="Header" class="android.widget.TextView" package="s" bounds="[126,40][558,115]" clickable="false" enabled="true"/></node>`,
    );
    const { nodes } = parseHierarchy(xml, { interactiveOnly: true });
    const container = nodes.find((n) => n.rect?.height === 2200);
    expect(container?.label).toBeUndefined();
  });
});

describe('switch rows take the row text as their name', () => {
  it('an unlabeled Switch is named after the passive label in its band', () => {
    const xml =
      `<hierarchy><node text="" class="android.widget.FrameLayout" package="s" bounds="[0,0][1080,2400]" clickable="false" enabled="true">` +
      `<node text="" class="android.widget.LinearLayout" package="s" bounds="[0,299][1080,513]" clickable="true" enabled="true">` +
      `<node text="Use Battery Saver" class="android.widget.TextView" package="s" bounds="[126,360][558,435]" clickable="false" enabled="true"/>` +
      `<node text="" class="android.widget.Switch" package="s" bounds="[880,320][1068,500]" clickable="true" checked="false" enabled="true"/>` +
      `</node></node></hierarchy>`;
    const { nodes } = parseHierarchy(xml, { interactiveOnly: true });
    expect(nodes.find((n) => n.type === 'Switch')?.label).toBe('Use Battery Saver');
    expect(nodes.find((n) => n.type === 'Button')?.label).toBe('Use Battery Saver');
  });
});
