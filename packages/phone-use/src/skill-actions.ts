import type { Action } from '@phone-use/sdk';
import type { SkillStep } from './skills.ts';

// ---------------------------------------------------------------------------
// Skill-step ⇄ Action conversion: the skills.ts step format aligns to the
// Action descriptor. The 1:1 subset converts; composite
// map-driven intents (goto/ask/search/search_open/toggle) return null — they
// are harness intents built ON the primitives, not primitives themselves, and
// stay skill-native. Full compiled-skill execution over executeAction is
// future work; today this module delivers the aligned types + the converter.
// ---------------------------------------------------------------------------

export function stepToAction(step: SkillStep): Action | null {
  switch (step.op) {
    case 'tap':
      return {
        formatVersion: 0,
        verb: 'tap',
        target: {
          label: step.label,
          ...(step.role === undefined ? {} : { role: step.role }),
          ...(step.near === undefined ? {} : { near: step.near }),
        },
      };
    case 'long_press':
      return {
        formatVersion: 0,
        verb: 'longPress',
        target: {
          label: step.label,
          ...(step.role === undefined ? {} : { role: step.role }),
          ...(step.near === undefined ? {} : { near: step.near }),
        },
      };
    case 'fill':
      return {
        formatVersion: 0,
        verb: 'fill',
        ...(step.field === undefined ? {} : { target: { label: step.field } }),
        params: { text: step.value },
      };
    case 'open_app':
      return { formatVersion: 0, verb: 'openApp', params: { app: step.app } };
    case 'open_url':
      return {
        formatVersion: 0,
        verb: 'openUrl',
        params: { url: step.url, ...(step.app === undefined ? {} : { app: step.app }) },
      };
    case 'back':
      return { formatVersion: 0, verb: 'back' };
    case 'home':
      return { formatVersion: 0, verb: 'home' };
    case 'alert':
      return { formatVersion: 0, verb: 'alert', params: { alertAction: step.action ?? 'accept' } };
    case 'verify':
      return { formatVersion: 0, verb: 'waitForText', params: { text: step.contains } };
    default:
      // goto/ask/search/search_open/toggle: composite map-driven intents.
      return null;
  }
}

export function actionToStep(action: Action): SkillStep | null {
  switch (action.verb) {
    case 'tap': {
      const label = action.target?.label ?? action.target?.id;
      if (!label) return null;
      return {
        op: 'tap',
        label,
        ...(action.target?.role === undefined ? {} : { role: action.target.role }),
        ...(action.target?.near === undefined ? {} : { near: action.target.near }),
      };
    }
    case 'longPress': {
      const label = action.target?.label ?? action.target?.id;
      if (!label) return null;
      return { op: 'long_press', label };
    }
    case 'fill':
      return {
        op: 'fill',
        value: action.params?.text ?? '',
        ...(action.target?.label === undefined ? {} : { field: action.target.label }),
      };
    case 'openApp':
      return action.params?.app ? { op: 'open_app', app: action.params.app } : null;
    case 'openUrl':
      return action.params?.url
        ? {
            op: 'open_url',
            url: action.params.url,
            ...(action.params.app === undefined ? {} : { app: action.params.app }),
          }
        : null;
    case 'back':
      return { op: 'back' };
    case 'home':
      return { op: 'home' };
    case 'alert':
      return {
        op: 'alert',
        ...(action.params?.alertAction === undefined ? {} : { action: action.params.alertAction }),
      };
    case 'waitForText':
      return action.params?.text ? { op: 'verify', contains: action.params.text } : null;
    default:
      return null;
  }
}
