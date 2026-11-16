import type { DeviceBackend, Snapshot } from '@phone-use/sdk';
import { z } from 'zod';
import { readWithRecovery } from './recovery.ts';

const text = z.string().trim().min(1);
export const expectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen'), contains: text, app: text.optional() }).strict(),
  z.object({ kind: z.literal('field'), label: text, equals: z.string(), app: text.optional() }).strict(),
  z.object({ kind: z.literal('app'), bundleId: text }).strict(),
]);
export type Expectation = z.infer<typeof expectationSchema>;
export type CheckResult = {
  id: string;
  status: 'passed' | 'failed' | 'unavailable';
  detail: string;
  at: string;
};
export type RunStatus = 'verified' | 'failed' | 'unverified' | 'stopped';
/** Caller-owned oracle, never a model-authored assertion or shell command. */
export type Verifier = {
  id: string;
  check(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
};

export function checkSnapshot(snapshot: Snapshot, expected: Expectation): Omit<CheckResult, 'id' | 'at'> {
  const app = expected.kind === 'app' ? expected.bundleId : expected.app;
  if (app && !snapshot.appBundleId)
    return { status: 'unavailable', detail: 'Backend did not identify the foreground app.' };
  if (app && snapshot.appBundleId !== app)
    return { status: 'failed', detail: `Expected app ${app}; observed ${snapshot.appBundleId}.` };
  if (expected.kind === 'app') return { status: 'passed', detail: `Foreground app is ${app}.` };
  if (snapshot.nodes.length === 0)
    return {
      status: 'unavailable',
      detail: 'Accessibility tree is empty; no screen assertion can be established.',
    };
  if (expected.kind === 'screen') {
    const found = snapshot.nodes.some((node) =>
      `${node.label ?? ''}\n${node.value ?? ''}`.toLowerCase().includes(expected.contains.toLowerCase()),
    );
    return {
      status: found ? 'passed' : 'failed',
      detail: `${found ? 'Found' : 'Did not find'} ${JSON.stringify(expected.contains)} in accessibility content. This checks UI text, not persisted state.`,
    };
  }
  const matches = snapshot.nodes.filter(
    (node) => node.label === expected.label || node.identifier === expected.label,
  );
  if (matches.length !== 1 || matches[0]?.value === undefined)
    return {
      status: 'unavailable',
      detail: `Field ${JSON.stringify(expected.label)} has no unique readable value.`,
    };
  const value = matches[0].value;
  return {
    status: value === expected.equals ? 'passed' : 'failed',
    detail: `Field ${JSON.stringify(expected.label)}: expected ${JSON.stringify(expected.equals)}, observed ${JSON.stringify(value)}.`,
  };
}

export async function verifyOutcome(
  backend: DeviceBackend,
  expectations: readonly Expectation[] = [],
  verifiers: readonly Verifier[] = [],
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (id: string, value: Omit<CheckResult, 'id' | 'at'>): void => {
    results.push({ id, ...value, at: new Date().toISOString() });
  };
  if (expectations.length) {
    try {
      signal?.throwIfAborted();
      const snapshot = await readWithRecovery(() => backend.snapshot(), { signal });
      expectations.forEach((expected, index) => {
        add(`expectation-${index + 1}`, checkSnapshot(snapshot, expectationSchema.parse(expected)));
      });
    } catch (error) {
      expectations.forEach((_, index) => {
        add(`expectation-${index + 1}`, { status: 'unavailable', detail: String(error) });
      });
    }
  }
  for (const verifier of verifiers) {
    try {
      signal?.throwIfAborted();
      const result = await readWithRecovery((boundedSignal) => verifier.check(boundedSignal), { signal });
      if (typeof result.ok !== 'boolean' || typeof result.detail !== 'string')
        throw new Error('Invalid verifier result');
      add(verifier.id, { status: result.ok ? 'passed' : 'failed', detail: result.detail });
    } catch (error) {
      add(verifier.id, { status: 'unavailable', detail: String(error) });
    }
  }
  return results;
}

export function outcomeStatus(
  execution: 'completed' | 'failed' | 'stopped',
  checks: readonly CheckResult[],
): RunStatus {
  if (execution === 'stopped') return 'stopped';
  if (execution === 'failed' || checks.some((check) => check.status === 'failed')) return 'failed';
  return checks.length > 0 && checks.every((check) => check.status === 'passed') ? 'verified' : 'unverified';
}

export const runExitCode = (status: RunStatus): number =>
  ({ verified: 0, failed: 1, unverified: 4, stopped: 130 })[status];
