import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runComparison, runComparisonCommand } from '../src/comparison.ts';

it('resets each trial, grades independently, counts false success and preserves unknown costs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-compare-'));
  try {
    const script = join(dir, 'adapter.mjs');
    await writeFile(
      script,
      `import fs from 'node:fs';
const state = process.env.PHONE_USE_EVAL_DIR + '/state';
const action = process.argv[2];
if (action === 'reset') fs.writeFileSync(state, 'before');
else if (action === 'grade') console.log(JSON.stringify({passed: fs.readFileSync(state, 'utf8') === 'after'}));
else { if (action === 'good') fs.writeFileSync(state, 'after');
console.log(JSON.stringify({model: process.env.PHONE_USE_EVAL_MODEL, reportedStatus: 'verified', modelCalls: 2})); }
`,
    );
    const cmd = (action: string) => [process.execPath, script, action];
    const result = await runComparison(
      {
        version: 1,
        model: 'fixture-model',
        repetitions: 2,
        tasks: [
          { id: 'task', goal: 'change state', state: 'cold', reset: cmd('reset'), grade: cmd('grade') },
        ],
        arms: [
          { id: 'honest', command: cmd('good') },
          { id: 'false-claim', command: cmd('bad') },
        ],
      },
      dir,
    );
    expect(result.trials).toHaveLength(4);
    expect(result.summary.find((s) => s.arm === 'honest')).toMatchObject({
      passed: 2,
      falseSuccesses: 0,
      costUsd: { known: 0, total: null },
    });
    expect(result.summary.find((s) => s.arm === 'false-claim')).toMatchObject({
      passed: 0,
      falseSuccesses: 2,
    });
    expect(result.trials.map((t) => t.arm)).toEqual(['honest', 'false-claim', 'false-claim', 'honest']);
    expect(JSON.parse(await readFile(join(result.directory, 'results.json'), 'utf8')).contractHash).toBe(
      result.contractHash,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('bounds commands that never exit', async () => {
  const result = await runComparisonCommand(
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    process.env,
    100,
  );
  expect(result.timedOut).toBe(true);
  expect(result.code).not.toBe(0);
});
