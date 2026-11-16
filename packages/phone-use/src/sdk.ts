import { randomUUID } from 'node:crypto';
import type { Device } from '@phone-use/sdk';
import { MAX_ITERATIONS, MODEL, SYSTEM } from './agent.ts';
import { claimDevice } from './device-claim.ts';
import { DeviceContext } from './device-context.ts';
import { defaultDeviceContext } from './driver.ts';
import { createExecution, withExecution } from './execution-context.ts';
import type { TurnRunner } from './harness.ts';
import { createAnthropicRunner } from './harness-anthropic.ts';
import { currentMode, type Mode } from './permissions.ts';
import { buildTools, type ConfirmRequest, type StepLog, type ToolEvent } from './tools.ts';
import { currentTraceSession, startTraceSessionFromEnv } from './trace-session.ts';
import {
  type CheckResult,
  type Expectation,
  expectationSchema,
  outcomeStatus,
  type RunStatus,
  type Verifier,
  verifyOutcome,
} from './verification.ts';

// ---------------------------------------------------------------------------
// The SDK surface — the third thin renderer over the one core (registry +
// driver + permission pipeline), alongside the MCP server (src/mcp.ts) and the
// CLI agent loop (src/agent.ts): a tiny
// `createSession({ onConfirm }) → session.prompt(goal)` embedding API.
//
// The SDK's differentiator over MCP is the permission gate. Over MCP the ask
// tier can only return a token and hope the client's own harness gates it; in
// the SDK, `onConfirm` is a REAL in-process callback. It is DENY-BY-DEFAULT:
// omit it and every action that would prompt is refused. Wire it to your own UI
// (a prompt, a Slack approval, a policy engine) to make the gate a hard stop.
//
// The model side rides the harness seam (harness.ts): a session drives one
// TurnRunner — Anthropic by default, or any caller-supplied runner. The
// permission pipeline gates every tool call INSIDE run(), so the floor holds
// identically no matter which runner reasons over the tools.
//
// Streaming: `onEvent` receives a tool event per step and an assistant event
// per model turn — a headless observer channel usable from day one. `stop()`
// aborts the in-flight/next API call (not a device action already mid-execution
// inside a tool handler).
// ---------------------------------------------------------------------------

export type {
  TurnCapability,
  TurnOutcome,
  TurnRequest,
  TurnRunner,
  TurnStatus,
  TurnTool,
} from './harness.ts';
export { createAnthropicRunner } from './harness-anthropic.ts';
export { createOpenAIRunner, type OpenAIRunnerOptions } from './harness-openai.ts';
export type { ConfirmRequest, Device, Mode, StepLog };

export type SessionEvent =
  | ({ type: 'tool' } & ToolEvent)
  | { type: 'assistant'; text: string }
  | { type: 'done'; status: PromptStatus; summary: string };

export type PromptStatus = RunStatus;
export type { CheckResult, Expectation, RunStatus, Verifier } from './verification.ts';
export type PromptOptions = { expectations?: Expectation[]; verifiers?: Verifier[] };

export type PromptResult = {
  schemaVersion: 1;
  runId: string;
  checks: CheckResult[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  executionStatus: 'completed' | 'failed' | 'stopped';
  status: PromptStatus;
  summary: string;
  steps: StepLog[];
  model: string;
};

export type SessionOptions = {
  /**
   * The permission gate for the ask tier — the SDK's differentiator over MCP.
   * DENY-BY-DEFAULT: if omitted, every action that would prompt is refused.
   * Return true to proceed; the approval is cached for the session so repeats of
   * the same action do not re-prompt.
   */
  onConfirm?: (req: ConfirmRequest) => boolean | Promise<boolean>;
  /** Permission mode floor: observe (read-only) | default | auto. Session-scoped. */
  mode?: Mode;
  /** Stream of tool + assistant events as the loop runs. */
  onEvent?: (e: SessionEvent) => void;
  /** Model override (default: PHONE_USE_MODEL or claude-opus-4-8). */
  model?: string;
  /** Max agent iterations per prompt (default: PHONE_USE_MAX_STEPS or 25). */
  maxSteps?: number;
  /** Anthropic API key (default: ANTHROPIC_API_KEY from the environment).
   *  Only consulted by the default runner — ignored when `runner` is given. */
  apiKey?: string;
  /**
   * The model loop that reasons over the tools (default: the Anthropic
   * runner). Session-scoped — the runner owns conversation history across
   * prompt() calls. The permission floor gates every tool call inside the
   * tools themselves, so no runner can weaken it.
   */
  runner?: TurnRunner;
  /** Override the system prompt (default: the built-in Phone Use prompt). */
  system?: string;
  /**
   * Bind the session to an explicit Device (from ios.launch()/connect()).
   * CALLER-OWNED: the session never closes it. Device state, permissions,
   * notes, and traces are isolated across asynchronous sessions.
   * Absent → the one booted simulator (refuses to guess when several are booted).
   */
  device?: Device;
};

export interface Session {
  /** Give the phone a natural-language goal; drives the loop to completion. */
  prompt(goal: string, options?: PromptOptions): Promise<PromptResult>;
  /** Abort the in-flight prompt's next API call. */
  stop(): void;
  /** Every tool step taken across this session's prompts (append-only). */
  readonly steps: readonly StepLog[];
}

export function createSession(options: SessionOptions = {}): Session {
  const model = options.model ?? MODEL;
  const maxSteps = options.maxSteps ?? MAX_ITERATIONS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive integer');
  const system = options.system ?? SYSTEM;
  // Explicit devices never alter the process-default facade.
  const execution = createExecution(
    options.device
      ? new DeviceContext(options.device.backend)
      : new DeviceContext(defaultDeviceContext().backend),
    options.mode ?? currentMode(),
    options.device?.platform,
  );

  // Deny-by-default: absent onConfirm means the ask tier is auto-refused. The
  // SDK always hands buildTools a gate, so it never falls back to the
  // model-facing renderAsk contract the MCP surface uses.
  const onConfirm = options.onConfirm ?? (() => false);

  const steps: StepLog[] = [];
  // The session's model loop. Session-scoped: the runner owns the persistent
  // conversation history, so prompt() can be called again to continue the same
  // thread. The default Anthropic runner constructs its client lazily, so
  // createSession stays key-free.
  const runner = options.runner ?? createAnthropicRunner({ apiKey: options.apiKey });
  let controller: AbortController | null = null;
  let running = false;

  async function prompt(goal: string, promptOptions: PromptOptions = {}): Promise<PromptResult> {
    const expectations = (promptOptions.expectations ?? []).map((e) => expectationSchema.parse(e));
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const stepStart = steps.length;
    if (running) throw new Error('a prompt is already in flight on this session');
    if (options.device?.isClosed) throw new Error('Device is closed');
    const release = claimDevice(options.device?.platform ?? 'implicit', options.device?.id ?? 'default');
    running = true;
    controller = new AbortController();

    // Trace artifact: if no session is active, start one from
    // the environment and OWN it — finish it when this prompt settles. A
    // session the caller started explicitly is never finished here.
    const ownedTrace = currentTraceSession() ? null : startTraceSessionFromEnv();
    // Object property (not a local) so the closure assignment in emit() isn't
    // erased by control-flow narrowing at the finally-block read.
    const outcome = { status: 'failed' as PromptStatus };

    const tools = buildTools(steps, {
      onConfirm,
      signal: controller.signal,
      onEvent: (e) => options.onEvent?.({ type: 'tool', ...e }),
    });

    const emit = async (
      executionStatus: 'completed' | 'failed' | 'stopped',
      summary: string,
    ): Promise<PromptResult> => {
      const checks =
        executionStatus === 'stopped'
          ? []
          : await verifyOutcome(
              execution.device.backend,
              expectations,
              promptOptions.verifiers,
              controller?.signal,
            );
      const status = controller?.signal.aborted ? 'stopped' : outcomeStatus(executionStatus, checks);
      outcome.status = status;
      options.onEvent?.({ type: 'done', status, summary });
      return {
        schemaVersion: 1,
        runId,
        status,
        executionStatus,
        summary,
        checks,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
        steps: steps.slice(stepStart).map((step) => structuredClone(step)),
        model,
      };
    };

    try {
      // Provider-legible failures (API errors, aborts) come back as a status;
      // the catch below only guards against a runner that throws unexpectedly.
      const outcome = await runner.runTurn({
        goal,
        system,
        model,
        maxSteps,
        tools,
        signal: controller.signal,
        onAssistantText: (text) => options.onEvent?.({ type: 'assistant', text }),
      });
      return await emit(outcome.status, outcome.summary);
    } catch (error) {
      return await emit('failed', `Agent error: ${String(error)}`);
    } finally {
      if (ownedTrace) {
        await ownedTrace
          .finish(
            outcome.status === 'verified' ? 'passed' : outcome.status === 'unverified' ? 'unknown' : 'failed',
          )
          .catch(() => undefined);
      }
      if (ownedTrace) execution.trace = null;
      release();
      running = false;
      controller = null;
    }
  }

  return {
    prompt: (goal, promptOptions) => withExecution(execution, () => prompt(goal, promptOptions)),
    stop: () => controller?.abort(),
    get steps() {
      return steps;
    },
  };
}

export {
  runWorkflow,
  type Workflow,
  type WorkflowOptions,
  type WorkflowResult,
  workflowSchema,
} from './workflow.ts';
