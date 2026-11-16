import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Device } from '@phone-use/sdk';
import { z } from 'zod';
import { claimDevice } from './device-claim.ts';
import { DeviceContext } from './device-context.ts';
import { createExecution, withExecution } from './execution-context.ts';
import type { Mode } from './permissions.ts';
import { waitForAppReady } from './readiness.ts';
import { readWithRecovery } from './recovery.ts';
import { REGISTRY } from './registry.ts';
import { toolFailed } from './tool-status.ts';
import { buildTools, type ConfirmRequest, type StepLog } from './tools.ts';
import { TraceSession } from './trace-session.ts';
import {
  type CheckResult,
  expectationSchema,
  outcomeStatus,
  type RunStatus,
  type Verifier,
  verifyOutcome,
} from './verification.ts';

export const workflowSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1),
    app: z.string().trim().min(1).optional(),
    install: z.string().trim().min(1).optional(),
    steps: z
      .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).strict())
      .max(500),
    expectations: z.array(expectationSchema).default([]),
  })
  .strict();
export type Workflow = z.input<typeof workflowSchema>;
export type WorkflowResult = {
  schemaVersion: 1;
  runId: string;
  name: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  device: { id: string; platform: string; backend: string };
  steps: StepLog[];
  checks: CheckResult[];
  failure?: { phase: string; step?: number; detail: string };
  artifacts: Record<string, string>;
  evidenceErrors: string[];
};
export type WorkflowOptions = {
  device: Device;
  outputDir?: string;
  mode?: Mode;
  onConfirm?: (request: ConfirmRequest) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  /** Explicit caller-owned build installer; it must target options.device. */
  installApp?: (path: string) => Promise<void>;
  verifiers?: Verifier[];
};

export function validateWorkflow(input: Workflow) {
  const workflow = workflowSchema.parse(input);
  const prepared = workflow.steps.map((step) => {
    const def = REGISTRY.find((tool) => tool.name === step.tool);
    if (!def) throw new Error(`Unknown workflow tool: ${step.tool}`);
    return { ...step, args: z.object(def.schema).strict().parse(step.args), risk: def.risk };
  });
  return { workflow, prepared };
}

export async function runWorkflow(input: Workflow, options: WorkflowOptions): Promise<WorkflowResult> {
  // Validate the entire flow before installing or executing its first action.
  const { workflow, prepared } = validateWorkflow(input);
  if (
    options.mode === 'observe' &&
    (workflow.install || workflow.app || prepared.some((step) => step.risk !== 'read'))
  ) {
    throw new Error('mode=observe prohibits installation, launch, and mutating workflow steps');
  }
  const device = options.device;
  if (device.isClosed) throw new Error(`Device ${device.id} is closed`);
  if (workflow.install && !options.installApp) throw new Error('This device has no configured app installer');
  const release = claimDevice(device.platform, device.id);
  const execution = createExecution(
    new DeviceContext(device.backend),
    options.mode ?? 'default',
    device.platform,
  );
  const runId = randomUUID();
  const start = performance.now();
  const result: WorkflowResult = {
    schemaVersion: 1,
    runId,
    name: workflow.name,
    status: 'unverified',
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: 0,
    device: { id: device.id, platform: device.platform, backend: device.backendName },
    steps: [],
    checks: [],
    artifacts: {},
    evidenceErrors: [],
  };
  const directory = options.outputDir ? join(options.outputDir, runId) : undefined;
  let phase = 'preflight';
  let stepIndex: number | undefined;
  let executionStatus: 'completed' | 'failed' | 'stopped' = 'completed';
  try {
    return await withExecution(execution, async () => {
      try {
        if (directory) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(join(directory, 'workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`, {
            mode: 0o600,
            flag: 'wx',
          });
          result.artifacts.workflow = join(directory, 'workflow.json');
          execution.trace = new TraceSession('on', {
            output: join(directory, 'trace.zip'),
            device: result.device,
          });
        }
        await readWithRecovery(() => device.backend.listApps(), { signal: options.signal });
        let before: unknown;
        try {
          before = await readWithRecovery(() => device.backend.snapshot(), { signal: options.signal });
        } catch (error) {
          if (
            !workflow.app ||
            !(error && typeof error === 'object' && 'code' in error && error.code === 'SESSION_NOT_FOUND')
          )
            throw error;
          before = { unavailable: 'No active app session before launch' };
        }
        if (directory) {
          await writeFile(join(directory, 'before.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
          result.artifacts.before = join(directory, 'before.json');
        }
        options.signal?.throwIfAborted();
        if (workflow.install) {
          phase = 'install';
          await options.installApp!(workflow.install);
        }
        if (workflow.app) {
          phase = 'launch';
          await device.backend.openApp({ app: workflow.app });
          phase = 'readiness';
          await waitForAppReady(device.backend, workflow.app, { signal: options.signal });
        }
        const tools = buildTools(result.steps, {
          onConfirm: options.onConfirm ?? (() => false),
          signal: options.signal,
        });
        phase = 'step';
        for (let index = 0; index < prepared.length; index++) {
          stepIndex = index + 1;
          options.signal?.throwIfAborted();
          const step = prepared[index]!;
          const tool = tools.find((tool) => tool.name === step.tool)!;
          const output = await tool.run(step.args);
          if (toolFailed(output)) throw new Error(output);
        }
      } catch (error) {
        executionStatus = options.signal?.aborted ? 'stopped' : 'failed';
        result.failure = {
          phase,
          ...(stepIndex === undefined ? {} : { step: stepIndex }),
          detail: String(error),
        };
      }
      result.checks =
        executionStatus === 'stopped'
          ? []
          : await verifyOutcome(device.backend, workflow.expectations, options.verifiers, options.signal);
      result.status = options.signal?.aborted ? 'stopped' : outcomeStatus(executionStatus, result.checks);
      if (!result.failure && result.status === 'failed')
        result.failure = {
          phase: 'verify',
          detail: result.checks
            .filter((check) => check.status === 'failed')
            .map((check) => check.detail)
            .join('\n'),
        };
      if (directory) {
        // Evidence failure cannot manufacture a passed check or hide execution failure.
        for (const [name, capture] of [
          [
            'after',
            async () => {
              const path = join(directory, 'after.json');
              await writeFile(
                path,
                JSON.stringify(await readWithRecovery(() => device.backend.snapshot()), null, 2),
                { mode: 0o600 },
              );
              return path;
            },
          ],
          [
            'screenshot',
            async () =>
              (
                await readWithRecovery(() =>
                  device.backend.screenshot({ path: join(directory, 'screen.png') }),
                )
              ).path,
          ],
          [
            'trace',
            async () =>
              (await execution.trace?.finish(
                result.status === 'verified'
                  ? 'passed'
                  : result.status === 'unverified'
                    ? 'unknown'
                    : 'failed',
              )) ?? '',
          ],
        ] as const) {
          try {
            if (options.signal?.aborted && name !== 'trace') continue;
            const path = await capture();
            if (path) result.artifacts[name] = path;
          } catch (error) {
            result.evidenceErrors.push(`${name}: ${String(error)}`);
          }
        }
      }
      result.endedAt = new Date().toISOString();
      result.durationMs = Math.round(performance.now() - start);
      if (directory) {
        result.artifacts.result = join(directory, 'result.json');
        await writeFile(result.artifacts.result, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      }
      return result;
    });
  } finally {
    release();
  }
}
