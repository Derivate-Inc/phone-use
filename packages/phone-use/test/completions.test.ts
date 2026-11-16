import { describe, expect, it } from 'vitest';
import { COMPLETION_SHELLS, completionScript } from '../src/completions.ts';
import { REGISTRY } from '../src/registry.ts';

describe('completionScript', () => {
  it.each(COMPLETION_SHELLS)('%s script covers every registry verb', (shell) => {
    const script = completionScript(shell);
    expect(script).toBeTruthy();
    for (const def of REGISTRY) expect(script).toContain(def.name);
    expect(script).toContain('doctor');
    // fish spells long flags `-l yes`; zsh/bash carry them verbatim.
    expect(script).toContain(shell === 'fish' ? '-l yes' : '--yes');
  });

  it('zsh script is a compdef with sanitized descriptions', () => {
    const script = completionScript('zsh') ?? '';
    expect(script.startsWith('#compdef phone-use')).toBe(true);
    // Descriptions ride in single quotes — no raw quotes/colons may survive
    // inside the value part of 'name:description' entries.
    for (const line of script.split('\n').filter((l) => l.trimStart().startsWith("'"))) {
      const inner = line.trim().slice(1, -1);
      expect(inner.slice(inner.indexOf(':') + 1)).not.toMatch(/[':"\\]/);
    }
  });

  it('returns null for an unknown shell', () => {
    expect(completionScript('powershell')).toBeNull();
  });
});
