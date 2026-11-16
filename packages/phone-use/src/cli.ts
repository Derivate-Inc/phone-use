import { z } from 'zod';
import * as driver from './driver.ts';
import { evaluate } from './permissions.ts';
import { REGISTRY, type ToolDef, targetOf, VISION_MARKER } from './registry.ts';
import { toolFailed } from './tool-status.ts';
import { trace } from './trace.ts';

// The CLI verb surface: the THIRD thin renderer over the shared registry
// (after the MCP server and the built-in agent loop). Any coding agent with a
// shell can drive the phone one command at a time — `phone-use tap "General"`
// — the agent-first-CLI pattern. Each
// invocation is a fresh process; the XCTest runner on the simulator keeps the device
// session warm, so a one-shot verb costs ~300ms, not a cold attach.
//
// One brain: definitions, handlers, and risk tags come from REGISTRY; the
// permission pipeline is the same evaluate() the other renderers call. The
// only CLI-specific piece is HOW the ask tier resolves: confirm tokens are
// process-local, so a two-phase token can't survive across one-shot
// invocations — instead `--yes` redeems the freshly minted token in-process,
// exactly as the SDK's onConfirm approval does (tools.ts). The first run
// without --yes still refuses, and deny is never overridable by any flag.

export type CliOutcome = {
  out: string;
  /** 0 ok · 1 handler error/failure · 2 blocked (deny) · 3 confirmation required */
  code: 0 | 1 | 2 | 3;
};

// The natural positional argument(s) per verb, in order — sugar so agents can
// write `phone-use goto Settings About` instead of flag soup. Everything is
// also reachable as a --flag; positionals just fill the listed keys first.
const POSITIONALS: Record<string, string[]> = {
  wait_for: ['text'],
  tap: ['label'],
  type: ['text'],
  scroll: ['direction'],
  drag: ['x', 'y', 'dx', 'dy'],
  handle_alert: ['action'],
  open: ['app'],
  nav: ['to'],
  goto: ['app', 'destination'],
  ask: ['field'],
  search: ['app', 'query'],
  toggle: ['app', 'switch'],
  batch: ['actions'],
  note: ['op', 'key', 'content'],
  skill: ['op', 'name'],
  atlas: ['op', 'app'],
};

// `phone-use atlas` with no args should keep meaning "overview" (the
// pre-verb-surface CLI behavior); same convenience for bare `skill` = list.
const DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  atlas: { op: 'overview' },
  skill: { op: 'list' },
};

type FlagSpec = {
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'json';
  values?: string[] | undefined;
  doc?: string | undefined;
};

function specOf(schema: z.core.$ZodType): FlagSpec {
  let inner: unknown = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap();
  const doc =
    (schema as { description?: string }).description ?? (inner as { description?: string }).description;
  if (inner instanceof z.ZodString) return { kind: 'string', doc };
  if (inner instanceof z.ZodNumber) return { kind: 'number', doc };
  if (inner instanceof z.ZodBoolean) return { kind: 'boolean', doc };
  if (inner instanceof z.ZodEnum) return { kind: 'enum', values: inner.options as string[], doc };
  return { kind: 'json', doc }; // objects/arrays/records ride as JSON strings
}

export type ParsedCli =
  | { ok: true; args: Record<string, unknown>; yes: boolean; help: boolean; json: boolean }
  | { ok: false; error: string };

/** Parse argv for one verb: positionals per POSITIONALS, then --flags typed off the zod schema. */
export function parseCliArgs(def: ToolDef, argv: string[]): ParsedCli {
  const specs = new Map<string, FlagSpec>(Object.entries(def.schema).map(([k, s]) => [k, specOf(s)]));
  const positionals = POSITIONALS[def.name] ?? [];
  const args: Record<string, unknown> = { ...(DEFAULT_ARGS[def.name] ?? {}) };
  let yes = false;
  let help = false;
  let json = false;
  let posIndex = 0;

  const coerce = (key: string, spec: FlagSpec, raw: string): string | number | boolean | unknown => {
    switch (spec.kind) {
      case 'number': {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new Error(`--${key} expects a number, got ${JSON.stringify(raw)}`);
        return n;
      }
      case 'boolean': {
        if (raw !== 'true' && raw !== 'false')
          throw new Error(`--${key} expects true|false, got ${JSON.stringify(raw)}`);
        return raw === 'true';
      }
      case 'enum': {
        if (!spec.values?.includes(raw))
          throw new Error(`--${key} must be one of: ${spec.values?.join(' | ')}`);
        return raw;
      }
      case 'json': {
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`--${key} expects JSON, got ${JSON.stringify(raw)}`);
        }
      }
      default:
        return raw;
    }
  };

  try {
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i] as string;
      if (tok === '--yes' || tok === '-y') {
        yes = true;
        continue;
      }
      if (tok === '--help' || tok === '-h') {
        help = true;
        continue;
      }
      if (tok === '--json') {
        json = true;
        continue;
      }
      if (tok.startsWith('--')) {
        const eq = tok.indexOf('=');
        const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
        const spec = specs.get(key);
        if (!spec)
          return {
            ok: false,
            error: `unknown flag --${key} for ${def.name}. Flags: ${[...specs.keys()].map((k) => `--${k}`).join(' ')}`,
          };
        if (eq !== -1) {
          args[key] = coerce(key, spec, tok.slice(eq + 1));
        } else if (spec.kind === 'boolean') {
          args[key] = true; // presence = true; --key=false for the explicit off
        } else {
          const next = argv[++i];
          if (next === undefined) return { ok: false, error: `--${key} needs a value` };
          args[key] = coerce(key, spec, next);
        }
        continue;
      }
      const posKey = positionals[posIndex++];
      if (!posKey) return { ok: false, error: `unexpected argument ${JSON.stringify(tok)} for ${def.name}` };
      const spec = specs.get(posKey);
      args[posKey] = spec ? coerce(posKey, spec, tok) : tok;
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, args, yes, help, json };
}

/**
 * `--json` envelope for one verb outcome: machine-parseable status + the
 * human text as `output`. The exit code carries the same information for
 * shells that ignore stdout (0 ok · 1 failed · 2 blocked · 3 confirm).
 */
export function jsonEnvelope(def: ToolDef, outcome: CliOutcome): string {
  const status = (['ok', 'failed', 'blocked', 'confirm_required'] as const)[outcome.code];
  return JSON.stringify({ tool: def.name, status, exitCode: outcome.code, output: outcome.out });
}

/** Usage text for one verb — written for agents: `--help` is the source of truth. */
export function toolHelp(def: ToolDef): string {
  const positionals = POSITIONALS[def.name] ?? [];
  const posDoc = positionals.map((p) => `<${p}>`).join(' ');
  const flags = Object.entries(def.schema)
    .filter(([k]) => !positionals.includes(k))
    .map(([k, s]) => {
      const spec = specOf(s);
      const type =
        spec.kind === 'enum' ? (spec.values?.join('|') ?? 'enum') : spec.kind === 'json' ? 'JSON' : spec.kind;
      return `  --${k} <${type}>${spec.doc ? `  ${spec.doc}` : ''}`;
    });
  const confirmNote =
    def.risk === 'read'
      ? ''
      : '\n\nDestructive targets (delete/pay/send/2FA) refuse on first run — re-run the SAME command with --yes to confirm. Deny-tier blocks cannot be overridden.';
  return `phone-use ${def.name}${posDoc ? ` ${posDoc}` : ''} [flags]\n\n${def.description}\n${flags.length ? `\nflags:\n${flags.join('\n')}` : ''}${confirmNote}`;
}

/** [name, one-line summary] per verb — the global help styles these. */
export function verbSummaries(): [string, string][] {
  return REGISTRY.map((d) => {
    // First sentence: a period followed by whitespace+capital (or end) — plain
    // split('.') would cut inside "e.g." and "i.e.".
    let summary = d.description.split(/\.(?=\s+[A-Z]|$)/)[0] ?? d.description;
    if (summary.length > 68) summary = `${summary.slice(0, 67).replace(/\s+\S*$/, '')}…`;
    return [d.name, summary];
  });
}

/**
 * Execute one registry verb from parsed argv: same evaluate() gate as the MCP
 * and agent renderers (deny → 2, ask → 3 with a --yes hint, allow → handler).
 */
export async function execCliTool(def: ToolDef, parsed: ParsedCli): Promise<CliOutcome> {
  if (!parsed.ok) return { out: `${parsed.error}\n\n${toolHelp(def)}`, code: 1 };
  if (parsed.help) return { out: toolHelp(def), code: 0 };
  const { args, yes } = parsed;
  const app = typeof args.app === 'string' ? args.app : undefined;

  const ctx = { tool: def.name, risk: def.risk, target: targetOf(def.name, args), app };
  let verdict = evaluate(ctx);
  // --yes resolves the ask tier exactly like the SDK's onConfirm approval:
  // redeem the freshly minted single-use token in-process (tools.ts flow).
  if (verdict.decision === 'ask' && yes) verdict = evaluate({ ...ctx, confirm: verdict.token });

  if (verdict.decision === 'deny') {
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
    return { out: `⛔ BLOCKED: ${verdict.reason}`, code: 2 };
  }
  if (verdict.decision === 'ask') {
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
    return {
      out: `⏸ CONFIRMATION REQUIRED: ${verdict.statement}\n${verdict.reason}\nRe-run the same command with --yes to proceed.`,
      code: 3,
    };
  }

  const t0 = performance.now();
  try {
    const result = await def.handler(args);
    const failed = toolFailed(result);
    trace({
      tool: def.name,
      args,
      risk: def.risk,
      decision: 'allow',
      app,
      ms: Math.round(performance.now() - t0),
      ok: !failed,
      detail: result.slice(0, 120),
    });
    if (def.imagePath && result.startsWith('/')) return { out: `Screenshot: ${result}`, code: 0 };
    // observe's blind-tree fallback: surface the attached screenshot path plainly.
    if (result.includes(`\n${VISION_MARKER}`))
      return { out: result.replace(`\n${VISION_MARKER}`, '\nScreenshot: '), code: 0 };
    return { out: result, code: failed ? 1 : 0 };
  } catch (error) {
    const msg = driver.describeError(error);
    trace({
      tool: def.name,
      args,
      risk: def.risk,
      decision: 'allow',
      app,
      ms: Math.round(performance.now() - t0),
      ok: false,
      detail: msg,
    });
    return { out: `ERROR: ${msg}`, code: 1 };
  }
}

/** Look up a registry verb by CLI command name (undefined = not a verb). */
export function cliVerb(name: string | undefined): ToolDef | undefined {
  return REGISTRY.find((d) => d.name === name);
}
