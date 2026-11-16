import { describe, expect, it } from 'vitest';
import { actionToStep, stepToAction } from '../src/skill-actions.ts';
import type { SkillStep } from '../src/skills.ts';

describe('skill-step ⇄ Action alignment (docs/20 item 4)', () => {
  const convertible: SkillStep[] = [
    { op: 'tap', label: 'Done', role: 'Button', near: 'Header' },
    { op: 'long_press', label: 'Message' },
    { op: 'fill', value: 'Ada', field: 'First name' },
    { op: 'fill', value: 'free text' },
    { op: 'open_app', app: 'Settings' },
    { op: 'open_url', url: 'maps://?q=coffee', app: 'Maps' },
    { op: 'back' },
    { op: 'home' },
    { op: 'alert', action: 'dismiss' },
    { op: 'verify', contains: 'Delivered' },
  ];

  it.each(convertible.map((s) => [s.op, s] as const))('%s round-trips through Action', (_op, step) => {
    const action = stepToAction(step);
    expect(action).not.toBeNull();
    expect(action?.formatVersion).toBe(0);
    const back = actionToStep(action!);
    expect(back).toEqual(step);
  });

  it('composite map-driven intents do not convert (they are not primitives)', () => {
    expect(stepToAction({ op: 'goto', app: 'Settings', destination: 'About' })).toBeNull();
    expect(stepToAction({ op: 'ask', field: 'iOS Version' })).toBeNull();
    expect(stepToAction({ op: 'search', app: 'Maps', query: 'coffee' })).toBeNull();
    expect(stepToAction({ op: 'search_open', app: 'Maps', query: 'coffee' })).toBeNull();
    expect(stepToAction({ op: 'toggle', app: 'Settings', switch: 'Wi-Fi' })).toBeNull();
  });

  it('actions are JSON-portable (a compiled skill is a stored Action[])', () => {
    const actions = convertible.map(stepToAction).filter((a) => a !== null);
    const wire = JSON.parse(JSON.stringify(actions));
    expect(wire).toEqual(actions);
  });
});
