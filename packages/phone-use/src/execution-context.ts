import { AsyncLocalStorage } from 'node:async_hooks';
import type { InstalledApp } from './apps.ts';
import type { DeviceContext } from './device-context.ts';
import type { Mode } from './permissions.ts';
import type { SkillStep } from './skills.ts';
import type { TraceSession } from './trace-session.ts';

/** Mutable task state follows asynchronous execution, never the last session created. */
export type ExecutionContext = {
  device: DeviceContext;
  platform?: string | undefined;
  mode: Mode;
  pendingTokens: Map<string, string>;
  grants: Set<string>;
  notes: Map<string, string>;
  recording: { name: string; description?: string | undefined; steps: SkillStep[] } | null;
  apps: InstalledApp[] | null;
  trace: TraceSession | null;
};

const storage = new AsyncLocalStorage<ExecutionContext>();
export const currentExecution = (): ExecutionContext | undefined => storage.getStore();
export function withExecution<T>(context: ExecutionContext, run: () => T): T {
  return storage.run(context, run);
}
export function createExecution(device: DeviceContext, mode: Mode, platform?: string): ExecutionContext {
  return {
    device,
    platform,
    mode,
    pendingTokens: new Map(),
    grants: new Set(),
    notes: new Map(),
    recording: null,
    apps: null,
    trace: null,
  };
}
