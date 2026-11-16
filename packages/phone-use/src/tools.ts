import { z } from 'zod';
import * as driver from './driver.ts';
import type { TurnTool } from './harness.ts';
import { evaluate, renderAsk } from './permissions.ts';
import { REGISTRY, type Risk, targetOf } from './registry.ts';
import { toolContent } from './tool-content.ts';
import { toolFailed } from './tool-status.ts';
import { trace } from './trace.ts';

export type StepLog = {
  tool: string;
  input: unknown;
  result: string;
  ms: number;
  at: string;
  /** what the permission gate decided for this step */
  decision?: 'allow' | 'deny' | 'ask';
};

// The ask tier, resolved through a real callback. Presented to the SDK caller so
// they can approve/decline in-process (deny-by-default: the SDK passes a gate
// that returns false when the app supplies none). The CLI/agent path passes no
// onConfirm and instead gets the two-phase renderAsk refusal (unchanged).
export type ConfirmRequest = {
  tool: string;
  statement: string;
  reason: string;
  risk: Risk;
  input: Record<string, unknown>;
};

// One event per executed/gated tool call — the SDK's UI/observer channel (the
// model gets the same result string; this carries the FULL, untruncated result).
export type ToolEvent = {
  tool: string;
  input: unknown;
  result: string;
  ms: number;
  decision: 'allow' | 'deny' | 'ask';
};

export type BuildToolsOpts = {
  signal?: AbortSignal | undefined;
  /** SDK gate for the ask tier. When present, an ask is resolved here instead of
   *  returned to the model as a renderAsk refusal. */
  onConfirm?: (req: ConfirmRequest) => boolean | Promise<boolean>;
  /** Streaming observer of every tool step. */
  onEvent?: (e: ToolEvent) => void;
};

// The built-in agent loop's tool surface: a thin renderer over the shared
// registry (src/registry.ts) — the MCP server renders the same definitions, so
// the three surfaces (MCP, agent loop, SDK) cannot drift. This file only adds
// the step logging the agent loop's TaskResult reports and the optional SDK
// hooks (onConfirm/onEvent). Output is provider-neutral TurnTool objects; the
// active TurnRunner converts them to its provider's tool format at the edge.

// Verbs whose repetition is legitimate: reading the screen, scrolling a long
// list, waiting, or stepping back are all normally done several times in a row.
const REPEATABLE = new Set(['observe', 'screenshot', 'wait_for', 'scroll', 'nav', 'note']);

/** Identity of an action for loop detection: the verb plus its arguments. */
function actionSignature(tool: string, input: Record<string, unknown>): string {
  const { confirm: _confirm, ...rest } = input;
  return `${tool}:${JSON.stringify(rest)}`;
}

/**
 * Has this exact action already been tried twice in the recent window? Exported
 * so the rule can be tested without driving a device.
 */
export function isLoopingAction(
  log: readonly StepLog[],
  tool: string,
  input: Record<string, unknown>,
): boolean {
  if (REPEATABLE.has(tool)) return false;
  const signature = actionSignature(tool, input);
  const repeats = log
    .slice(-6)
    .filter((step) => actionSignature(step.tool, step.input as Record<string, unknown>) === signature);
  return repeats.length >= 2;
}

export function buildTools(log: StepLog[], opts: BuildToolsOpts = {}): TurnTool[] {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => {
      opts.signal?.throwIfAborted();
      return action();
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const wrap = (tool: string, run: (input: Record<string, unknown>, entry: StepLog) => Promise<string>) => {
    return (input: Record<string, unknown>): Promise<string> =>
      serialize(async () => {
        // Runner-side loop breaker. The two-strike rule lives in the system
        // prompt, but a model that has convinced itself an action *should* work
        // will keep retrying it — one campaign task burned 51 turns this way.
        // A prompt cannot enforce this on itself; the runner can.
        if (isLoopingAction(log, tool, input)) {
          const refusal = `BLOCKED — you have already run \`${tool}\` with these exact arguments twice in the last 6 steps and the goal is not closer. Do not repeat it. Change mechanism instead: a different element, scroll to reveal the target, handle_alert in case a dialog is blocking, search instead of navigating, or a deep link. If the goal cannot be reached, say so and stop.`;
          const blocked: StepLog = {
            tool,
            input,
            result: refusal,
            ms: 0,
            at: new Date().toISOString(),
            decision: 'deny',
          };
          log.push(blocked);
          opts.onEvent?.({ tool, input, result: refusal, ms: 0, decision: 'deny' });
          return refusal;
        }
        const entry: StepLog = { tool, input, result: '', ms: 0, at: new Date().toISOString() };
        log.push(entry);
        const start = performance.now();
        try {
          const result = await run(input, entry);
          entry.result = result.length > 400 ? `${result.slice(0, 400)}…` : result;
          // Event carries the FULL result (the model-visible string is truncated
          // only for the StepLog); fire after ms is known.
          entry.ms = Math.round(performance.now() - start);
          opts.onEvent?.({ tool, input, result, ms: entry.ms, decision: entry.decision ?? 'allow' });
          return result;
        } catch (error) {
          entry.result = `ERROR: ${driver.describeError(error)}`;
          entry.ms = Math.round(performance.now() - start);
          opts.onEvent?.({
            tool,
            input,
            result: entry.result,
            ms: entry.ms,
            decision: entry.decision ?? 'allow',
          });
          return entry.result;
        }
      });
  };

  return REGISTRY.map((def) => {
    const schema =
      def.risk === 'read'
        ? def.schema
        : {
            ...def.schema,
            confirm: z
              .string()
              .optional()
              .describe('Confirmation token from a prior confirmation-required result'),
          };
    const tool: TurnTool = {
      name: def.name,
      description: def.description,
      inputSchema: z.object(schema),
      run: wrap(def.name, async (args, entry) => {
        const app = typeof args.app === 'string' ? args.app : undefined;
        const ctx = {
          tool: def.name,
          risk: def.risk,
          target: targetOf(def.name, args),
          app,
          confirm: typeof args.confirm === 'string' ? args.confirm : undefined,
        };
        let verdict = evaluate(ctx);

        // Ask tier: with an SDK gate, resolve it here. Approve → redeem the
        // single-use token via evaluate (which also caches the session grant,
        // exactly as the MCP re-call path does — one shared brain). Decline →
        // deny. Without a gate, fall through to the model-facing renderAsk.
        if (verdict.decision === 'ask' && opts.onConfirm) {
          const approved = await opts.onConfirm({
            tool: def.name,
            statement: verdict.statement,
            reason: verdict.reason,
            risk: def.risk,
            input: args,
          });
          verdict = approved
            ? evaluate({ ...ctx, confirm: verdict.token })
            : { decision: 'deny', reason: `user declined "${ctx.target ?? def.name}"` };
        }

        if (verdict.decision === 'deny') {
          entry.decision = 'deny';
          trace({
            tool: def.name,
            args,
            risk: def.risk,
            decision: 'deny',
            app,
            ms: 0,
            ok: false,
            detail: verdict.reason,
          });
          return `⛔ BLOCKED: ${verdict.reason}`;
        }
        if (verdict.decision === 'ask') {
          entry.decision = 'ask';
          trace({
            tool: def.name,
            args,
            risk: def.risk,
            decision: 'ask',
            app,
            ms: 0,
            ok: false,
            detail: verdict.reason,
          });
          return renderAsk(verdict);
        }

        opts.signal?.throwIfAborted();
        entry.decision = 'allow';
        const t0 = performance.now();
        const result = await def.handler(args);
        trace({
          tool: def.name,
          args,
          risk: def.risk,
          decision: 'allow',
          app,
          ms: Math.round(performance.now() - t0),
          ok: !toolFailed(result),
          detail: result.slice(0, 120),
        });
        return result;
      }),
    };
    tool.runRich = async (args) => toolContent(await tool.run(args), def.imagePath);
    return tool;
  });
}
