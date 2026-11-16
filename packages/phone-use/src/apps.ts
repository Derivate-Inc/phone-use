import { currentExecution } from './execution-context.ts';
// The whole-phone layer: a registry of installed apps (human name ↔ bundle id).
// Observation is scoped to the frontmost app, so the home screen is not a map
// to crawl — but openApp(bundleId) *is* the cross-app
// transition. Resolving a natural app name to its bundle id lets the atlas span
// the phone: "go to Settings > About" resolves the app, opens it, then runs the
// per-app map.

export type InstalledApp = { name: string; bundleId: string };

let cache: InstalledApp[] | null = null;

// A remote device (cloud sandbox or on-phone runner) is being driven: local
// simctl describes the WRONG device — a locally booted sim's app list must
// never leak into resolution for the remote one (e.g. "Clock" resolving to a
// benchmark clone installed only locally).
function remoteBackendActive(): boolean {
  return Boolean(process.env.PHONE_USE_SANDBOX_URL || process.env.PHONE_USE_RUNNER_URL);
}

// Stock apps present on every iOS simulator: listApps() on remote backends
// only reports user-installed apps, so natural names for the built-ins are
// resolved from this table, verified against a live iOS 26.5 simulator.
// (No Clock, Notes, Mail, or Freeform — simulators don't ship them.)
const STOCK_SIM_APPS: InstalledApp[] = [
  { name: 'Settings', bundleId: 'com.apple.Preferences' },
  { name: 'Calendar', bundleId: 'com.apple.mobilecal' },
  { name: 'Reminders', bundleId: 'com.apple.reminders' },
  { name: 'Safari', bundleId: 'com.apple.mobilesafari' },
  { name: 'Photos', bundleId: 'com.apple.mobileslideshow' },
  { name: 'Maps', bundleId: 'com.apple.Maps' },
  { name: 'Contacts', bundleId: 'com.apple.MobileAddressBook' },
  { name: 'Files', bundleId: 'com.apple.DocumentsApp' },
  { name: 'Messages', bundleId: 'com.apple.MobileSMS' },
  { name: 'Health', bundleId: 'com.apple.Health' },
  { name: 'News', bundleId: 'com.apple.news' },
  { name: 'Shortcuts', bundleId: 'com.apple.shortcuts' },
  { name: 'Fitness', bundleId: 'com.apple.Fitness' },
  { name: 'Passwords', bundleId: 'com.apple.Passwords' },
  { name: 'Wallet', bundleId: 'com.apple.Passbook' },
  { name: 'Preview', bundleId: 'com.apple.Preview' },
];

// listApps() entries arrive as "Name (bundle.id)" or a bare bundle id.
function parseListedApp(entry: string): InstalledApp {
  const match = entry.match(/^(.*)\s\(([^)]+)\)\s*$/);
  if (match?.[1] && match[2]) return { name: match[1].trim(), bundleId: match[2] };
  return { name: entry, bundleId: entry };
}

// An Android device lists its packages, system ones included (com.android.*,
// com.google.android.*); an iOS device never lists those.
function looksAndroid(entries: readonly string[]): boolean {
  return entries.some((entry) => /^(android$|com\.android\.|com\.google\.android\.)/.test(entry));
}

async function remoteApps(): Promise<InstalledApp[]> {
  let listed: InstalledApp[] = [];
  try {
    const { defaultDeviceContext } = await import('./driver.ts');
    const raw = await defaultDeviceContext().backend.listApps();
    // A cloud Android phone: the iOS stock table would turn "Settings" into
    // com.apple.Preferences, and fuzzy matching over package names picks
    // com.android.providers.settings. Pass names through, as for a local
    // Android device; the Android backend resolves them to packages itself.
    if (looksAndroid(raw)) return [];
    listed = raw
      .map(parseListedApp)
      .filter(
        (a) =>
          !a.name.includes('-Runner') &&
          !a.name.includes('UITests') &&
          !a.bundleId.includes('.PreviewShell') &&
          !a.bundleId.includes('.Bridge') &&
          !a.bundleId.endsWith('.xctrunner'),
      );
  } catch {
    /* backend unreachable — stock table still resolves the built-ins */
  }
  const seen = new Set(listed.map((a) => a.bundleId));
  return [...listed, ...STOCK_SIM_APPS.filter((a) => !seen.has(a.bundleId))].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export async function installedApps(force = false): Promise<InstalledApp[]> {
  const scoped = currentExecution();
  if (scoped) {
    if (scoped.apps && !force) return scoped.apps;
    // Android: pass names through to the backend, which resolves them to
    // packages (fuzzy matching here picks com.android.providers.settings
    // for "Settings").
    if (scoped.platform === 'android') {
      scoped.apps = [];
      return scoped.apps;
    }
    const listed = (await scoped.device.backend.listApps()).map(parseListedApp);
    const seen = new Set(listed.map((app) => app.bundleId));
    scoped.apps =
      scoped.platform === 'ios'
        ? [...listed, ...STOCK_SIM_APPS.filter((app) => !seen.has(app.bundleId))]
        : listed;
    return scoped.apps;
  }
  if (cache && !force) return cache;
  // A real iPhone reached through Mirroring cannot be enumerated — there is no
  // listapps for someone else's hardware. Returning empty makes resolveApp pass
  // the human name straight through, which is exactly what Spotlight wants.
  // Falling through here would instead resolve names against whatever simulator
  // happens to be booted, so "Weather" would silently become a benchmark app.
  if (process.env.PHONE_USE_DEVICE === 'mirror') return [];
  // Android has no simctl listing; enumerating here would fall through to
  // whatever iOS SIMULATOR happens to be booted and resolve "Settings" to the
  // iOS com.apple.Preferences. The Android backend resolves names → packages
  // itself (openApp/resolvePackage), so pass the human name straight through.
  if (process.env.PHONE_USE_DEVICE === 'android') return [];
  if (remoteBackendActive()) {
    cache = await remoteApps();
    return cache;
  }
  // Local simulator: ask the backend, which lists apps on the simulator it is
  // actually pinned to (never "the first booted one").
  cache = await remoteApps();
  return cache;
}

// Resolve a natural app name (or bundle id) to a bundle id. Exact name → prefix
// → substring → bundle-id match, case-insensitive.
export async function resolveApp(query: string): Promise<InstalledApp | null> {
  const q = query.trim().toLowerCase();
  const apps = await installedApps();
  if (apps.length === 0) return q.includes('.') ? { name: query, bundleId: query } : null;
  return (
    apps.find((a) => a.bundleId.toLowerCase() === q) ??
    apps.find((a) => a.name.toLowerCase() === q) ??
    apps.find((a) => a.name.toLowerCase().startsWith(q)) ??
    apps.find((a) => a.name.toLowerCase().includes(q)) ??
    apps.find((a) => a.bundleId.toLowerCase().includes(q)) ??
    (q.includes('.') ? { name: query, bundleId: query } : null)
  );
}
