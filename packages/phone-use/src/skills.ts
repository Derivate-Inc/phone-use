import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listMaps, loadMap, saveMap } from './appmap.ts';
import { resolveApp } from './apps.ts';
import * as driver from './driver.ts';
import { smartGoto } from './explore.ts';
import { assertSafeName } from './names.ts';
import {
  answerAcrossApps,
  answerField,
  longPressControl,
  search,
  searchAndOpen,
  setField,
  tapControl,
  toggleField,
  verifyScreen,
} from './task.ts';
import { currentTraceSession } from './trace-session.ts';

// A Skill is a named, ordered chain of the intent primitives (open/goto/ask/
// toggle/search/search_open) with variable capture between steps: any step can
// name its output with `as`, and later steps interpolate it as `{{name}}` in
// their string args. Recorded once, replayed forever with ZERO model calls —
// the deterministic composite/cross-app layer on top of the primitives.

const io = { loadMap, saveMap, listMaps };

export type SkillStep =
  | { op: 'open_app'; app: string }
  | { op: 'goto'; app: string; destination: string }
  | { op: 'ask'; field: string; app?: string; as?: string }
  | { op: 'toggle'; app: string; switch: string; on?: boolean }
  | { op: 'search'; app: string; query: string; submit?: boolean }
  | { op: 'search_open'; app: string; query: string; match?: string; as?: string }
  | { op: 'tap'; label: string; app?: string; role?: string; near?: string }
  | { op: 'fill'; value: string; field?: string; app?: string }
  | { op: 'verify'; contains: string }
  | { op: 'open_url'; url: string; app?: string }
  | { op: 'back' }
  | { op: 'home' }
  | { op: 'long_press'; label: string; app?: string; role?: string; near?: string }
  | { op: 'alert'; action?: 'accept' | 'dismiss' };

// `params` are the skill's run-time inputs (e.g. ["place"]); their values are
// supplied as args at run time and seed the context, so {{place}} in any step
// resolves. This is what makes a recorded errand generalize to many.
//
// `precondition` is an optional guard (text expected on the current screen)
// checked BEFORE any step runs — a recorded skill is safe to replay only in the
// context it was recorded for (Mobile-Agent-E's precondition-gated shortcuts,
// research brief 2). If it doesn't hold, the run fails fast with a clear reason
// instead of firing steps into the wrong screen.
export type Skill = {
  name: string;
  description?: string | undefined;
  params?: string[] | undefined;
  precondition?: string | undefined;
  steps: SkillStep[];
};

export type StepResult = { op: string; ok: boolean; detail: string; attempts?: number | undefined };
export type SkillRun = { ok: boolean; skill: string; steps: StepResult[]; context: Record<string, string> };

// Replace {{name}} references with captured values (missing → empty string).
function subst(value: string, ctx: Record<string, string>): string {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => ctx[k] ?? '');
}

async function toBundle(app: string): Promise<string> {
  return (await resolveApp(app))?.bundleId ?? app;
}

// Fields whose literal value can be promoted to a {{param}} slot (never `op`,
// which would corrupt the step, nor `as`, a capture name).
const VALUE_FIELDS = new Set([
  'app',
  'destination',
  'field',
  'switch',
  'query',
  'match',
  'label',
  'value',
  'contains',
  'url',
]);

// Turn literal values in a recorded skill into parameters: for each
// param→literal binding, replace occurrences of the literal in value fields with
// {{param}} and declare the param. So a skill recorded with query "coffee"
// becomes a reusable "search for {{place}}".
export function parameterizeSkill(skill: Skill, bindings: Record<string, string>): Skill {
  const params = new Set(skill.params ?? []);
  const steps = skill.steps.map((step) => {
    const out: Record<string, unknown> = { ...step };
    for (const [k, v] of Object.entries(step)) {
      if (!VALUE_FIELDS.has(k) || typeof v !== 'string') continue;
      let nv = v;
      for (const [param, literal] of Object.entries(bindings)) {
        if (literal && nv.includes(literal)) {
          nv = nv.split(literal).join(`{{${param}}}`);
          params.add(param);
        }
      }
      out[k] = nv;
    }
    return out as SkillStep;
  });
  return { ...skill, steps, params: [...params] };
}

export type RunOptions = { retries?: number | undefined };

// Execute a skill top to bottom, threading captured variables. `args` supplies
// the declared params and seeds the context. Each step retries on failure
// (transient misses: cold launches, mid-animation taps, focus races) — safe
// because every op returns ok:false ONLY when the action didn't take effect, so
// a retry never double-acts. A step that still fails after its retries stops the
// run (later steps likely depend on it) and reports how far it got.
export async function runSkill(
  skill: Skill,
  args: Record<string, string> = {},
  opts: RunOptions = {},
): Promise<SkillRun> {
  const retries = Math.max(0, opts.retries ?? 1);
  const missing = (skill.params ?? []).filter((p) => !args[p]);
  if (missing.length) {
    return {
      ok: false,
      skill: skill.name,
      steps: [{ op: '(params)', ok: false, detail: `missing required arg(s): ${missing.join(', ')}` }],
      context: {},
    };
  }
  const ctx: Record<string, string> = { ...args };
  const steps: StepResult[] = [];

  // Precondition guard: don't replay a recorded errand into the wrong context.
  // Interpolated so a param can appear in the guard (e.g. "{{place}}").
  if (skill.precondition) {
    const need = subst(skill.precondition, ctx);
    await driver.observe();
    const check = await verifyScreen(need);
    if (!check.ok) {
      return {
        ok: false,
        skill: skill.name,
        steps: [
          {
            op: '(precondition)',
            ok: false,
            detail: `precondition not met: expected "${need}" on screen — ${check.detail}`,
          },
        ],
        context: ctx,
      };
    }
    steps.push({ op: '(precondition)', ok: true, detail: `precondition met: "${need}"` });
  }

  for (const raw of skill.steps) {
    // Interpolate every string field from the running context first.
    const step = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? subst(v, ctx) : v]),
    ) as SkillStep;

    let result: StepResult;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        result = await runStep(step, ctx);
      } catch (error) {
        result = { op: step.op, ok: false, detail: `error: ${driver.describeError(error)}` };
      }
      if (result.ok || attempt > retries) break;
      await Bun.sleep(700); // let the screen settle before retrying
    }
    result.attempts = attempt;
    steps.push(result);
    if (!result.ok) return { ok: false, skill: skill.name, steps, context: ctx };
  }
  return { ok: true, skill: skill.name, steps, context: ctx };
}

async function runStep(step: SkillStep, ctx: Record<string, string>): Promise<StepResult> {
  switch (step.op) {
    case 'open_app': {
      const detail = await driver.openApp(await toBundle(step.app));
      return { op: 'open_app', ok: true, detail };
    }
    case 'goto': {
      const r = await smartGoto(await toBundle(step.app), step.destination, io);
      return { op: 'goto', ok: r.ok, detail: r.ok ? `reached ${step.destination}` : `failed: ${r.reason}` };
    }
    case 'ask': {
      const r = step.app
        ? await answerField(await toBundle(step.app), step.field, io)
        : await answerAcrossApps(step.field, io);
      if (r.ok && r.value != null && step.as) ctx[step.as] = r.value;
      return { op: 'ask', ok: r.ok, detail: r.ok ? `${step.field} = ${r.value}` : `failed: ${r.reason}` };
    }
    case 'toggle': {
      const r = await toggleField(await toBundle(step.app), step.switch, io, step.on);
      return {
        op: 'toggle',
        ok: r.ok,
        detail: r.ok
          ? `${step.switch}: ${r.before} → ${r.after}${r.changed ? '' : ' (already set)'}`
          : `failed: ${r.reason}`,
      };
    }
    case 'search': {
      const r = await search(await toBundle(step.app), step.query, step.submit);
      return {
        op: 'search',
        ok: r.ok,
        detail: r.ok ? `searched "${step.query}" in ${step.app}` : `failed: ${r.reason}`,
      };
    }
    case 'search_open': {
      const r = await searchAndOpen(await toBundle(step.app), step.query, step.match);
      if (r.ok && r.opened && step.as) ctx[step.as] = r.opened;
      return { op: 'search_open', ok: r.ok, detail: r.ok ? `opened "${r.opened}"` : `failed: ${r.reason}` };
    }
    case 'tap': {
      const r = await tapControl(step.label, step.app ? await toBundle(step.app) : undefined, {
        ...(step.role === undefined ? {} : { role: step.role }),
        ...(step.near === undefined ? {} : { near: step.near }),
      });
      return {
        op: 'tap',
        ok: r.ok,
        detail: r.ok ? `tapped "${r.label}"${r.changed ? '' : ' (no change)'}` : `failed: ${r.reason}`,
      };
    }
    case 'fill': {
      const r = await setField(step.value, step.field, step.app ? await toBundle(step.app) : undefined);
      return {
        op: 'fill',
        ok: r.ok,
        detail: r.ok ? `filled "${r.field}" = "${step.value}"` : `failed: ${r.reason}`,
      };
    }
    case 'verify': {
      const r = await verifyScreen(step.contains);
      currentTraceSession()?.addVerdict({
        kind: 'verdict',
        source: 'skill-verify',
        expect: step.contains,
        ok: r.ok,
        detail: r.detail,
      });
      return { op: 'verify', ok: r.ok, detail: r.detail };
    }
    case 'open_url': {
      const detail = await driver.openUrl(step.url, step.app ? await toBundle(step.app) : undefined);
      return { op: 'open_url', ok: true, detail };
    }
    case 'back': {
      await driver.goBack();
      await driver.observe();
      return { op: 'back', ok: true, detail: 'went back' };
    }
    case 'home': {
      await driver.goHome();
      await driver.observe();
      return { op: 'home', ok: true, detail: 'went home' };
    }
    case 'long_press': {
      const r = await longPressControl(step.label, step.app ? await toBundle(step.app) : undefined);
      return {
        op: 'long_press',
        ok: r.ok,
        detail: r.ok ? `long-pressed "${r.label}"` : `failed: ${r.reason}`,
      };
    }
    case 'alert': {
      // Clear an interrupting system prompt (permission / confirmation) so the
      // errand can continue. Absent alert = safe no-op.
      const action = step.action ?? 'dismiss';
      const a = await driver.handleAlert(action);
      await driver.observe();
      return {
        op: 'alert',
        ok: true,
        detail: a.present ? `${action}ed alert — ${a.description ?? ''}`.trim() : 'no alert (no-op)',
      };
    }
  }
}

// ---- Persistence: skills live alongside maps, so a phone accrues a library ----
const SKILL_DIR = process.env.PHONE_USE_SKILL_DIR ?? join(homedir(), '.phone-use', 'skills');

export async function saveSkill(skill: Skill): Promise<string> {
  await mkdir(SKILL_DIR, { recursive: true });
  const path = join(SKILL_DIR, `${assertSafeName(skill.name, 'skill')}.json`);
  await Bun.write(path, JSON.stringify(skill, null, 2));
  return path;
}

export async function loadSkill(name: string): Promise<Skill | null> {
  const file = Bun.file(join(SKILL_DIR, `${assertSafeName(name, 'skill')}.json`));
  if (!(await file.exists())) return null;
  return (await file.json()) as Skill;
}

// Delete a saved skill. Returns whether it existed.
export async function forgetSkill(name: string): Promise<boolean> {
  const file = Bun.file(join(SKILL_DIR, `${assertSafeName(name, 'skill')}.json`));
  if (!(await file.exists())) return false;
  await file.delete();
  return true;
}

export async function listSkills(): Promise<string[]> {
  const out: string[] = [];
  try {
    const glob = new Bun.Glob('*.json');
    for await (const f of glob.scan({ cwd: SKILL_DIR })) out.push(f.replace(/\.json$/, ''));
  } catch {
    /* no skills yet */
  }
  return out;
}
