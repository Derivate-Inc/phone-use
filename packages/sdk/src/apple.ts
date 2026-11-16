import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Apple toolchain discovery. simctl and xcodebuild only exist inside a full
// Xcode; when `xcode-select` points at the Command Line Tools (the default
// after `xcode-select --install`), every simctl call fails with "unable to find
// utility". Instead of asking the user to run `sudo xcode-select -s`, we find
// the installed Xcode and pass DEVELOPER_DIR to our own child processes only.
// Global settings are never changed.
// ---------------------------------------------------------------------------

let cached: { dir: string | undefined; source: string } | undefined;

function isFullXcode(dir: string): boolean {
  return existsSync(`${dir}/usr/bin/xcodebuild`) && existsSync(`${dir}/Platforms/iPhoneSimulator.platform`);
}

/**
 * The developer directory to use for simctl/xcodebuild, and where it came from:
 * `DEVELOPER_DIR` when set, else `xcode-select -p` when that is a full Xcode,
 * else the first Xcode found in /Applications (or by Spotlight).
 */
export function resolveDeveloperDir(): { dir: string | undefined; source: string } {
  if (cached) return cached;
  const fromEnv = process.env.DEVELOPER_DIR;
  if (fromEnv && isFullXcode(fromEnv)) {
    cached = { dir: fromEnv, source: 'DEVELOPER_DIR' };
    return cached;
  }
  let selected: string | undefined;
  try {
    selected = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  } catch {
    selected = undefined;
  }
  if (selected && isFullXcode(selected)) {
    cached = { dir: selected, source: 'xcode-select' };
    return cached;
  }
  const candidates = ['/Applications/Xcode.app/Contents/Developer'];
  try {
    const found = execFileSync('mdfind', ["kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"], {
      encoding: 'utf8',
      timeout: 3000,
    });
    for (const app of found.split('\n').filter(Boolean)) candidates.push(`${app}/Contents/Developer`);
  } catch {
    /* Spotlight unavailable; the /Applications default still applies */
  }
  const dir = candidates.find(isFullXcode);
  cached = dir
    ? {
        dir,
        source: `found ${dir.replace('/Contents/Developer', '')} (xcode-select points to ${selected ?? 'nothing'})`,
      }
    : { dir: undefined, source: 'no full Xcode installed' };
  return cached;
}

/** Environment for Apple tool child processes: the caller's env plus DEVELOPER_DIR. */
export function appleEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const { dir } = resolveDeveloperDir();
  if (dir) env.DEVELOPER_DIR = dir;
  return { ...env, ...extra };
}

/** @internal test hook */
export function resetDeveloperDirCache(): void {
  cached = undefined;
}
