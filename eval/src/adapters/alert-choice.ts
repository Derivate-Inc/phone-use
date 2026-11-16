// Which button of a permission prompt an agent presses to accept or decline, for tools that have no
// alert verb (Maestro, Mobilerun): the agent reads the buttons and picks one by its words. The
// vocabulary is phone-use's own (packages/sdk/src/observe.ts ALERT_ACCEPT / ALERT_DISMISS), so
// every tool declines with the same words. Without button roles, only exact phrases are trusted;
// "Ask App Not to Track" is the App Tracking Transparency decline, which phone-use reaches through
// its "any other button" fallback.

const ACCEPT = [
  'allow while using app',
  'always allow',
  'allow',
  'ok',
  'yes',
  'continue',
  'allow once',
  'turn on',
  'enable',
  'agree',
  'accept',
  'got it',
  'join',
];
const DISMISS = [
  "don't allow",
  'ask app not to track',
  'not now',
  'cancel',
  'no thanks',
  'no',
  'deny',
  'dismiss',
  'later',
  'skip',
  "don't",
];

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").trim();

/** The label to press among `labels` (what the screen shows), or undefined when none fits. */
export function pickAlertLabel(labels: string[], action: 'accept' | 'dismiss'): string | undefined {
  for (const want of action === 'accept' ? ACCEPT : DISMISS) {
    const hit = labels.find((l) => norm(l) === want);
    if (hit) return hit;
  }
  return undefined;
}
