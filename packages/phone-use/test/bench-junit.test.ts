import { describe, expect, it } from 'vitest';
import { type BenchResult, junitReport } from '../src/bench.ts';

const pass: BenchResult = {
  name: 'settings nav',
  klass: 'goto',
  ok: true,
  ms: 1500,
  detail: 'ok',
  attempts: 1,
};
const fail: BenchResult = {
  name: 'toggle "Wi-Fi" <fast>',
  klass: 'toggle',
  ok: false,
  ms: 250,
  detail: 'Could not find switch & friends',
  attempts: 2,
};

describe('junitReport', () => {
  it('emits a well-formed suite with pass and failure cases', () => {
    const xml = junitReport([pass, fail]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites tests="2" failures="1"');
    expect(xml).toContain('<testcase classname="goto" name="settings nav" time="1.500"/>');
    expect(xml).toContain('<failure message="Could not find switch &amp; friends"/>');
  });

  it('escapes XML metacharacters in names', () => {
    const xml = junitReport([fail]);
    expect(xml).toContain('name="toggle &quot;Wi-Fi&quot; &lt;fast&gt;"');
    expect(xml).not.toContain('<fast>');
  });

  it('reports zero failures for an all-green run', () => {
    const xml = junitReport([pass]);
    expect(xml).toContain('failures="0"');
    expect(xml).not.toContain('<failure');
  });
});
