import { describe, expect, it } from 'vitest';
import { detectBlindTree } from '../src/blind-tree.ts';

describe('detectBlindTree', () => {
  it('fires on the real canvas page: Chrome chrome is labelled, the page is pixels', () => {
    // Measured on a OnePlus Nord: a <canvas> page draws "Kyoto" as pixels. The
    // tree has 8 labelled toolbar nodes OUTSIDE the WebView and nothing inside.
    const v = detectBlindTree([
      { role: 'WebView', label: 'Canvas', rect: { x: 0, y: 330, width: 1080, height: 2000 } },
      { role: 'TextView', label: 'No internet connection', rect: { x: 300, y: 100, width: 400, height: 50 } },
      { role: 'Button', label: 'Open the homepage', rect: { x: 20, y: 200, width: 80, height: 80 } },
      {
        role: 'TextField',
        label: '127.0.0.1:8765/canvas.html',
        rect: { x: 130, y: 200, width: 500, height: 80 },
      },
      { role: 'Button', label: 'New tab', rect: { x: 700, y: 200, width: 80, height: 80 } },
      { role: 'Button', label: 'Switch or close tabs', rect: { x: 820, y: 200, width: 80, height: 80 } },
      {
        role: 'Button',
        label: 'Update available. More options',
        rect: { x: 950, y: 200, width: 80, height: 80 },
      },
    ]);
    expect(v.blind).toBe(true);
    if (v.blind) expect(v.reason).toMatch(/WebView/);
  });

  it('stays quiet on a rendered DOM page: readable nodes INSIDE the WebView', () => {
    // Measured: a normal HTML page exposes its headline/paragraphs as TextViews
    // inside the WebView rect. That is readable — no vision needed.
    const v = detectBlindTree([
      { role: 'WebView', label: 'Kyoto', rect: { x: 0, y: 330, width: 1080, height: 2000 } },
      { role: 'TextView', label: 'Kyoto', rect: { x: 60, y: 400, width: 200, height: 80 } },
      {
        role: 'TextView',
        label: 'Kyoto is a city in the Kansai region of Japan.',
        rect: { x: 60, y: 520, width: 900, height: 60 },
      },
      { role: 'Button', label: 'New tab', rect: { x: 700, y: 200, width: 80, height: 80 } },
    ]);
    expect(v.blind).toBe(false);
  });

  it('fires on iOS: Safari reports a WKWebView as Element(58) spanning the FULL screen', () => {
    // Measured on an iPhone 17 Pro simulator: the web area claims (0,0 402x874),
    // so Safari's own bar (Back, Page Menu, Address, refresh, More) sits
    // geometrically INSIDE it. Those are browser chrome, not page content.
    const v = detectBlindTree([
      { role: 'Application', label: 'Safari', rect: { x: 0, y: 0, width: 402, height: 874 } },
      { role: 'Element(58)', label: 'WebView', rect: { x: 0, y: 0, width: 402, height: 874 } },
      { role: 'Other', label: 'Canvas', rect: { x: 0, y: 62, width: 429, height: 714 } },
      { role: 'Button', label: 'Back', rect: { x: 34, y: 792, width: 48, height: 48 } },
      { role: 'Button', label: 'Page Menu', rect: { x: 94, y: 796, width: 40, height: 40 } },
      { role: 'TextField', label: 'Address', rect: { x: 168, y: 806, width: 66, height: 20 } },
      { role: 'Button', label: 'refresh', rect: { x: 279, y: 805, width: 17, height: 21 } },
      { role: 'Button', label: 'More', rect: { x: 320, y: 792, width: 48, height: 48 } },
    ]);
    expect(v.blind).toBe(true);
    if (v.blind) expect(v.reason).toMatch(/Element\(58\)/);
  });

  it('stays quiet on iOS when the page has real content inside the web area', () => {
    const v = detectBlindTree([
      { role: 'Element(58)', label: 'WebView', rect: { x: 0, y: 0, width: 402, height: 874 } },
      {
        role: 'StaticText',
        label: 'Kyoto is a city in the Kansai region of Japan.',
        rect: { x: 20, y: 200, width: 360, height: 40 },
      },
      { role: 'Link', label: 'Read more about Kyoto', rect: { x: 20, y: 260, width: 200, height: 30 } },
      { role: 'Button', label: 'Back', rect: { x: 34, y: 792, width: 48, height: 48 } },
    ]);
    expect(v.blind).toBe(false);
  });

  it('fires on a Flutter app: one FlutterView and nothing else', () => {
    expect(
      detectBlindTree([{ role: 'FlutterView', label: '', rect: { x: 0, y: 0, width: 1080, height: 2400 } }])
        .blind,
    ).toBe(true);
  });

  it('fires on an empty tree', () => {
    expect(detectBlindTree([]).blind).toBe(true);
  });

  it('does NOT fire on a normal native screen', () => {
    const v = detectBlindTree([
      { role: 'Button', label: 'Wi-Fi' },
      { role: 'Button', label: 'Bluetooth' },
      { role: 'TextView', label: 'Connected devices' },
      { role: 'Switch', label: 'Airplane mode' },
    ]);
    expect(v.blind).toBe(false);
  });

  it('does NOT fire on a small legit screen (a dialog) with no opaque container', () => {
    const v = detectBlindTree([
      { role: 'StaticText', label: 'Delete this note?' },
      { role: 'Button', label: 'Cancel' },
    ]);
    expect(v.blind).toBe(false);
  });

  it('does NOT fire when a WebView sits beside real readable content', () => {
    // A Flutter app exposing Semantics, or a hybrid page with native text.
    const v = detectBlindTree([
      { role: 'WebView', label: '', rect: { x: 0, y: 0, width: 1080, height: 2000 } },
      { role: 'StaticText', label: 'Welcome back, Rajmeet', rect: { x: 40, y: 100, width: 500, height: 60 } },
      { role: 'Button', label: 'Continue to checkout', rect: { x: 40, y: 200, width: 500, height: 80 } },
      { role: 'StaticText', label: 'Your cart has 3 items', rect: { x: 40, y: 300, width: 500, height: 60 } },
    ]);
    expect(v.blind).toBe(false);
  });

  it('ignores resource ids and lone symbols as "content"', () => {
    const v = detectBlindTree([
      { role: 'WebView', label: '', rect: { x: 0, y: 300, width: 1080, height: 2000 } },
      {
        role: 'View',
        label: 'com.android.chrome:id/toolbar',
        rect: { x: 0, y: 100, width: 1080, height: 150 },
      },
      { role: 'TextView', label: '•', rect: { x: 500, y: 500, width: 20, height: 20 } },
    ]);
    expect(v.blind).toBe(true);
  });
});
