import { currentExecution } from './execution-context.ts';
import type { Risk } from './registry.ts';

// ---------------------------------------------------------------------------
// The permission pipeline (harness v2, decision doc research/10 §3).
//
// Evaluation order per action — the Claude Code ordering, transposed to a
// device: DENY → ALLOW → ASK → mode default. Three modes:
//   observe  — read-only: observation and map reads run; anything that touches
//              the screen is blocked.
//   default  — navigation runs free; mutating actions on sensitive targets
//              require a two-phase confirmation.
//   auto     — mutating actions run free EXCEPT destructive targets, which
//              still require confirmation.
// There is deliberately NO bypass mode: the deny tier (destructive targets
// with no live confirmation) is un-overridable by any mode, flag, env var, or
// config. A phone holds messages, money, and identity — a "skip it all"
// escape hatch would make the harness a liability (see research/7's don't-copy
// and research/10 §3). This is a product decision, not a default.
//
// Risk has two layers: the VERB tag on each ToolDef is the floor; the resolved
// TARGET (element label/role) is the ceiling — a `toggle` is generally safe,
// but a toggle labeled "Delete Account" classifies as destructive regardless
// of verb (Codex's argument-level vetting, transposed from shell flags to UI
// targets).
//
// Honesty note (MCP): an MCP server cannot pop UI. The ask tier returns a
// structured refusal carrying a one-time confirm token; executing requires a
// second call with that token. Over MCP this guarantees an explicit, visible,
// auditable second decision in the client's transcript — it does NOT prove a
// human approved it; the client harness's own permission system is the human
// gate. In the SDK, wire onConfirm to a real callback for a hard gate.
// ---------------------------------------------------------------------------

export type Mode = 'observe' | 'default' | 'auto';

let mode: Mode = (process.env.PHONE_USE_MODE as Mode) || 'default';
export function setMode(m: Mode): void {
  const scoped = currentExecution();
  if (scoped) scoped.mode = m;
  else mode = m;
}
export function currentMode(): Mode {
  return currentExecution()?.mode ?? mode;
}

// Destructive-target lexicon: matched against the RESOLVED target's label (and
// alert button labels). Deliberately hard-coded — not user-configurable — so
// no configuration can silently disable the floor.
const DESTRUCTIVE =
  /\b(delete|erase|remove|pay|buy|purchase|send|transfer|subscribe|sign (out|off)|log out|reset|format|wipe|unpair|block|report)\b/i;
const SENSITIVE_FIELD =
  /\b(password|passcode|verification code|2fa|one.?time code|otp|cvv|card number|ssn)\b/i;

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string; token: string; statement: string };

// One-time confirm tokens (ask tier). Session-scoped, single-use.
const defaultPendingTokens = new Map<string, string>(); // token -> action fingerprint
// Granted escalations: (tool|app|target-class) approved once stays approved
// for the session — approving "send message in Messages" shouldn't re-prompt
// per keystroke. Never persisted.
const defaultGrants = new Set<string>();

function fingerprint(tool: string, app: string | undefined, target: string | undefined): string {
  return `${tool}|${app ?? ''}|${(target ?? '').toLowerCase().slice(0, 60)}`;
}

function newToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type ActionContext = {
  tool: string;
  risk: Risk;
  /** resolved target label (element about to be tapped/toggled/filled) if known */
  target?: string | undefined;
  /** target element role if known */
  role?: string | undefined;
  app?: string | undefined;
  /** confirm token passed back by the caller for a previously asked action */
  confirm?: string | undefined;
};

// Classify the effective risk: verb floor, element-target ceiling.
export function effectiveRisk(ctx: ActionContext): Risk {
  if (ctx.risk === 'read') return 'read';
  const target = ctx.target ?? '';
  if (DESTRUCTIVE.test(target) || SENSITIVE_FIELD.test(target)) return 'destructive';
  return ctx.risk;
}

export function evaluate(ctx: ActionContext): Verdict {
  const scoped = currentExecution();
  const pendingTokens = scoped?.pendingTokens ?? defaultPendingTokens;
  const grants = scoped?.grants ?? defaultGrants;
  const mode = currentMode();
  const risk = effectiveRisk(ctx);
  const fp = fingerprint(ctx.tool, ctx.app, ctx.target);

  // Mode: observe blocks anything non-read outright.
  if (mode === 'observe' && risk !== 'read') {
    return {
      decision: 'deny',
      reason: `mode=observe is read-only; "${ctx.tool}" is ${risk}. Switch mode to act.`,
    };
  }

  // Confirm-token redemption: a valid token for this exact action fingerprint
  // converts an ask into an allow and caches the grant.
  if (ctx.confirm) {
    const expected = pendingTokens.get(ctx.confirm);
    if (expected === fp) {
      pendingTokens.delete(ctx.confirm);
      grants.add(fp);
      return { decision: 'allow' };
    }
    return {
      decision: 'deny',
      reason: 'invalid or expired confirm token (tokens are single-use and action-specific)',
    };
  }

  // Session grant cache.
  if (grants.has(fp)) return { decision: 'allow' };

  // Destructive targets always ask — in every mode. This is the un-overridable
  // floor: no mode makes "Delete"/"Pay"/"Send" silent.
  if (risk === 'destructive') {
    const token = newToken();
    pendingTokens.set(token, fp);
    const statement = `This will ${ctx.tool} "${ctx.target ?? '?'}"${ctx.app ? ` in ${ctx.app}` : ''} — a potentially irreversible action.`;
    return {
      decision: 'ask',
      reason: 'destructive target',
      token,
      statement,
    };
  }

  // Mutating actions: ask in default mode, allow in auto.
  if (risk === 'mutate' && mode === 'default') {
    // Navigation-adjacent mutations (taps that just move around) are the bulk
    // of phone driving; asking on every one would make default unusable. The
    // ask tier in default mode applies to typed input and toggles — actions
    // that change state rather than position. Plain taps ride as navigate.
    if (ctx.tool === 'type' || ctx.tool === 'toggle') {
      const token = newToken();
      pendingTokens.set(token, fp);
      return {
        decision: 'ask',
        reason: 'state-changing action in default mode',
        token,
        statement: `This will ${ctx.tool}${ctx.target ? ` "${ctx.target}"` : ''}${ctx.app ? ` in ${ctx.app}` : ''}.`,
      };
    }
  }

  return { decision: 'allow' };
}

// Render an ask verdict as the structured tool result the model sees. The
// re-call contract keeps the decision visible in the transcript.
export function renderAsk(v: Extract<Verdict, { decision: 'ask' }>): string {
  return [
    `⏸ CONFIRMATION REQUIRED — ${v.statement}`,
    `Reason: ${v.reason}.`,
    `If the user's goal clearly authorizes this, re-call the SAME tool with the same arguments plus confirm: "${v.token}".`,
    `If not, stop and ask the user. Tokens are single-use and specific to this exact action.`,
  ].join('\n');
}
