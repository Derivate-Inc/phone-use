import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Config-file defaults for the PHONE_USE_* env surface. The env vars stay the
// single runtime source of truth — everything downstream reads process.env —
// so config files only fill in what the environment leaves unset. Precedence:
// real environment > ./.phone-use.json (project) > ~/.phone-use/config.json
// (user). Keys are the exact env-var names, e.g. {"PHONE_USE_DEVICE":
// "launch"}. ANTHROPIC_API_KEY is refused by design: secrets belong in the
// environment or a secret manager, never in a file that gets committed.
// ---------------------------------------------------------------------------

const ENV_KEY_RE = /^PHONE_USE_[A-Z0-9_]+$/;

export const USER_CONFIG_PATH = join(homedir(), '.phone-use', 'config.json');
export const PROJECT_CONFIG_NAME = '.phone-use.json';

export type SettingsLayer = { path: string; values: Record<string, unknown> };
export type SettingsReport = { applied: Record<string, string>; warnings: string[] };

/**
 * Pure merge: earlier layers win over later ones; the real environment wins
 * over every layer. Returns what would be applied plus human-readable
 * warnings for ignored keys — no process.env mutation here.
 */
export function mergeSettings(
  env: Record<string, string | undefined>,
  layers: SettingsLayer[],
): SettingsReport {
  const applied: Record<string, string> = {};
  const warnings: string[] = [];
  for (const { path, values } of layers) {
    for (const [key, raw] of Object.entries(values)) {
      if (key === 'ANTHROPIC_API_KEY') {
        warnings.push(`${path}: ANTHROPIC_API_KEY belongs in the environment, not a config file — ignored`);
        continue;
      }
      if (!ENV_KEY_RE.test(key)) {
        warnings.push(
          `${path}: unknown key ${JSON.stringify(key)} (expected a PHONE_USE_* env name) — ignored`,
        );
        continue;
      }
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        warnings.push(`${path}: ${key} must be a string, number, or boolean — ignored`);
        continue;
      }
      if (env[key] !== undefined || key in applied) continue;
      applied[key] = String(raw);
    }
  }
  return { applied, warnings };
}

function readLayer(path: string, warnings: string[]): SettingsLayer | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // absent is the normal case
  }
  try {
    const values = JSON.parse(text) as unknown;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('top level must be an object');
    }
    return { path, values: values as Record<string, unknown> };
  } catch (error) {
    warnings.push(`${path}: invalid config — ${(error as Error).message} — ignored`);
    return null;
  }
}

/**
 * Load config-file defaults into process.env (environment always wins) and
 * report ignored keys on stderr. Called once at CLI startup, before any
 * device or model wiring reads the env.
 */
export function loadSettings(cwd = process.cwd()): SettingsReport {
  const warnings: string[] = [];
  const layers = [join(cwd, PROJECT_CONFIG_NAME), USER_CONFIG_PATH]
    .map((p) => readLayer(p, warnings))
    .filter((l): l is SettingsLayer => l !== null);
  const report = mergeSettings(process.env, layers);
  report.warnings.unshift(...warnings);
  for (const [key, value] of Object.entries(report.applied)) {
    process.env[key] = value;
    configApplied.add(key);
  }
  for (const warning of report.warnings) console.error(`config: ${warning}`);
  return report;
}

const configApplied = new Set<string>();

/**
 * Whether an env var's current value came from a config file rather than the
 * real environment. Lets downstream precedence treat config values as the
 * defaults they are: an explicitly exported var can outrank another env var,
 * while the same var merely defaulted from config.json cannot.
 */
export function isConfigDefault(key: string): boolean {
  return configApplied.has(key);
}
