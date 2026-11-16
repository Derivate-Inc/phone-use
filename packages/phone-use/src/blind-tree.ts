// Blind-tree detection — when the accessibility tree cannot see the screen.
//
// Measured on a real Android (OnePlus Nord): Chrome with a rendered Wikipedia
// article dumps 32 nodes and ZERO readable page content — only the URL bar.
// Flutter renders to one Skia canvas; Compose and WebViews are opaque to
// uiautomator; iOS WKWebView content is often absent from the AX tree too.
// An agent that trusts the tree alone sits on a blank screen forever.
//
// This is the automatic switch: a pure, testable judgement over the structured
// elements that says "the tree is blind here — go look". The observe verb uses
// it to attach a set-of-marks screenshot on its own, so vision costs an
// inference call only when the cheap tree has actually failed.

export type BlindRect = { x: number; y: number; width: number; height: number };
export type BlindTreeElement = {
  role?: string | undefined;
  label?: string | undefined;
  rect?: BlindRect | undefined;
};

export type BlindVerdict = { blind: false } | { blind: true; reason: string };

/** Container roles that are opaque to accessibility trees on every platform. */
const OPAQUE_ROLES = new Set([
  'WebView',
  'WKWebView',
  'WebArea',
  'FlutterView',
  'Canvas',
  'SurfaceView',
  'TextureView',
  'GLSurfaceView',
  'UnityPlayer',
  'Web View',
]);

/**
 * iOS reports a WKWebView as XCUIElementType.webView, which the SDK renders as
 * the numeric role `Element(58)` — measured on an iPhone 17 Pro simulator:
 * Safari on a <canvas> page yields `[Element(58)] "Canvas"` spanning the full
 * screen with zero page text inside it. Treat that numeric type as opaque.
 */
const OPAQUE_NUMERIC = new Set(['Element(58)']);

/** Structural roles whose labels describe layout, not content. */
const CONTAINER_ROLES = new Set([
  'ScrollView',
  'Window',
  'Application',
  'Other',
  'Group',
  'FrameLayout',
  'LinearLayout',
  'RelativeLayout',
  'ViewGroup',
  'View',
  'RecyclerView',
  'LinearLayoutCompat',
]);

/**
 * Browser chrome that can sit INSIDE the web area's reported rect. iOS reports
 * a WKWebView as the full screen (0,0 402x874 on an iPhone 17 Pro), so Safari's
 * own address bar and nav buttons fall inside it geometrically. They are the
 * browser, not the page — identify them by role+label, not position.
 */
// Measured labels: Safari (iPhone 17 Pro sim) = Back, Page Menu, refresh, More,
// Tabs, Share, Bookmarks; Chrome (OnePlus Nord) = New tab, Switch or close
// tabs, Open the homepage, Update available. More options.
const CHROME_BUTTONS =
  /^(back|forward|tabs|share|bookmarks|reading list|reload|refresh|stop|more|page menu|menu|new tab|switch or close tabs|open the homepage|home|more options|update available\. more options|cancel)$/i;
function isBrowserChrome(e: BlindTreeElement): boolean {
  const label = (e.label ?? '').trim();
  const role = e.role ?? '';
  if (role === 'TextField' && (/^address$/i.test(label) || CHROME_LABEL.test(label))) return true;
  if (role === 'Button' && CHROME_BUTTONS.test(label)) return true;
  return false;
}

function isOpaque(role: string | undefined): boolean {
  if (!role) return false;
  return OPAQUE_ROLES.has(role) || OPAQUE_NUMERIC.has(role);
}

/** Chrome-like OS chrome that appears even when the page itself is invisible. */
const CHROME_LABEL = /^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}(\/|$))/i;

function meaningful(label: string | undefined): boolean {
  if (!label) return false;
  const t = label.trim();
  // A URL bar, a lone symbol, or a resource id is not page content.
  if (t.length < 3) return false;
  if (CHROME_LABEL.test(t)) return false;
  if (/^[a-z0-9_.]+:id\/[a-z0-9_]+$/i.test(t)) return false;
  return true;
}

/**
 * Decide whether the current tree is blind to the screen's real content.
 *
 * Fires when an opaque container is present and the rest of the tree carries
 * almost no meaningful labels — i.e. the platform handed us a shell around
 * content it cannot describe. A small-but-legit screen (a dialog with two
 * buttons) does NOT fire: it has no opaque container.
 */
export function detectBlindTree(elements: readonly BlindTreeElement[]): BlindVerdict {
  if (elements.length === 0) return { blind: true, reason: 'the accessibility tree is empty' };
  const opaque = elements.filter((e) => isOpaque(e.role));
  // Only LEAF content counts as readable. Containers and chrome — a scroll
  // view ("Vertical scroll bar, 2 pages"), a window, a generic group — carry
  // labels yet are not something an agent reads or taps. Measured on an
  // iPhone 17 Pro simulator: Safari's ScrollView sits inside the WKWebView
  // rect with a readable label, and counting it hid a fully blind canvas.
  const readable = elements.filter(
    (e) => meaningful(e.label) && !CONTAINER_ROLES.has(e.role ?? '') && !isBrowserChrome(e),
  );

  if (opaque.length > 0) {
    // Content lives INSIDE the opaque container's rectangle; the app's own
    // chrome (a browser toolbar, "No internet connection") lives outside it.
    // Measured on a real Android: Chrome rendering a canvas page has 8 labelled
    // toolbar nodes and zero page nodes — counting chrome as content hid the
    // exact case this exists for. So judge by containment, not by count.
    const inside = (e: BlindTreeElement, box: BlindRect) =>
      !!e.rect &&
      e.rect.x >= box.x - 1 &&
      e.rect.y >= box.y - 1 &&
      e.rect.x + e.rect.width <= box.x + box.width + 1 &&
      e.rect.y + e.rect.height <= box.y + box.height + 1;
    for (const box of opaque) {
      if (!box.rect) continue;
      // A tiny container (an icon-sized WebView) is not the screen's content.
      if (box.rect.width * box.rect.height < 40_000) continue;
      const contentInside = readable.filter((e) => e !== box && inside(e, box.rect as BlindRect));
      if (contentInside.length === 0) {
        return { blind: true, reason: `${box.role} content is not in the accessibility tree` };
      }
    }
    // Every sizeable opaque container has readable content inside it — a
    // rendered DOM page, or a Flutter app exposing Semantics. Readable.
    return { blind: false };
  }
  // No opaque container, but a screen whose tree has nothing readable at all
  // is still blind (a full-screen canvas with no role, a game).
  if (readable.length === 0 && elements.length >= 3) {
    return { blind: true, reason: 'no readable labels anywhere on screen' };
  }
  return { blind: false };
}
