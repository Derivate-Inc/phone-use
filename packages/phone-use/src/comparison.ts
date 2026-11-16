import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const command = z.array(z.string()).min(1);
export const comparisonSchema = z
  .object({
    version: z.literal(1),
    model: z.string().min(1),
    seed: z.number().int().default(0),
    repetitions: z.number().int().min(1).max(20).default(3),
    timeoutMs: z.number().int().min(100).max(900_000).default(300_000),
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            goal: z.string().min(1),
            state: z.enum(['cold', 'warm']),
            reset: command,
            grade: command,
          })
          .strict(),
      )
      .min(1),
    arms: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), command }).strict()).min(2),
  })
  .strict();

const reportSchema = z.object({
  model: z.string(),
  reportedStatus: z.enum(['verified', 'failed', 'unverified']),
  modelCalls: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
type CommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number };

/** No shell interpolation. Kill the process group on timeout so descendants cannot keep driving the phone. */
export function runComparisonCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(argv[0]!, argv.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Math.round(performance.now() - start) });
    };
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > 2_000_000) {
        stdout = stdout.slice(0, 2_000_000);
        stderr += '\nstdout limit exceeded';
        kill();
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-200_000);
    });
    child.on('error', (error) => {
      stderr += String(error);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export type ComparisonTrial = {
  task: string;
  arm: string;
  repetition: number;
  state: 'cold' | 'warm';
  setupFailed: boolean;
  executionFailed: boolean;
  graded: boolean;
  passed: boolean;
  falseSuccess: boolean;
  reportedStatus?: string;
  durationMs: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  directory: string;
};

export function summarizeComparison(trials: ComparisonTrial[]) {
  return [...new Set(trials.map((trial) => `${trial.arm}:${trial.state}`))].map((key) => {
    const rows = trials.filter((trial) => `${trial.arm}:${trial.state}` === key);
    const measured = rows
      .filter((row) => !row.setupFailed)
      .map((row) => row.durationMs)
      .sort((a, b) => a - b);
    const usage = (field: 'modelCalls' | 'inputTokens' | 'outputTokens' | 'costUsd') => {
      const known = rows.flatMap((row) => (row[field] === undefined ? [] : [row[field]!]));
      return { known: known.length, total: known.length ? known.reduce((sum, n) => sum + n, 0) : null };
    };
    return {
      arm: rows[0]!.arm,
      state: rows[0]!.state,
      trials: rows.length,
      passed: rows.filter((row) => row.passed).length,
      successRate: rows.filter((row) => row.passed).length / rows.length,
      falseSuccesses: rows.filter((row) => row.falseSuccess).length,
      setupFailures: rows.filter((row) => row.setupFailed).length,
      executionFailures: rows.filter((row) => row.executionFailed).length,
      ungraded: rows.filter((row) => !row.graded).length,
      medianMs: measured.length ? measured[Math.floor(measured.length / 2)] : null,
      p95Ms: measured.length ? measured[Math.ceil(measured.length * 0.95) - 1] : null,
      modelCalls: usage('modelCalls'),
      inputTokens: usage('inputTokens'),
      outputTokens: usage('outputTokens'),
      costUsd: usage('costUsd'),
    };
  });
}

export async function runComparison(
  input: unknown,
  outputDir: string,
  onProgress?: (message: string) => void,
) {
  const contract = comparisonSchema.parse(input);
  for (const rows of [contract.tasks, contract.arms])
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error('Task and arm IDs must be unique');
  const canonical = JSON.stringify(contract);
  const contractHash = createHash('sha256').update(canonical).digest('hex');
  const directory = join(outputDir, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (path: string, value: unknown) =>
    writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await save(join(directory, 'contract.json'), contract);
  const trials: ComparisonTrial[] = [];
  for (const task of contract.tasks)
    for (let repetition = 0; repetition < contract.repetitions; repetition++) {
      // Deterministic rotation limits systematic first-arm advantage; never run two arms on one phone concurrently.
      const offset =
        (((contract.seed + repetition) % contract.arms.length) + contract.arms.length) % contract.arms.length;
      const arms = [...contract.arms.slice(offset), ...contract.arms.slice(0, offset)];
      for (const arm of arms) {
        const trialDir = join(directory, `${task.id}-${repetition + 1}-${arm.id}`);
        await mkdir(trialDir, { mode: 0o700 });
        const knowledge =
          task.state === 'cold'
            ? join(trialDir, 'knowledge')
            : join(directory, `knowledge-${task.id}-${arm.id}`);
        await mkdir(knowledge, { recursive: true, mode: 0o700 });
        const env = {
          ...process.env,
          PHONE_USE_EVAL_GOAL: task.goal,
          PHONE_USE_EVAL_TASK: task.id,
          PHONE_USE_EVAL_MODEL: contract.model,
          PHONE_USE_EVAL_ARM: arm.id,
          PHONE_USE_EVAL_SEED: String(contract.seed),
          PHONE_USE_EVAL_REPETITION: String(repetition + 1),
          PHONE_USE_EVAL_STATE: task.state,
          PHONE_USE_EVAL_DIR: trialDir,
          PHONE_USE_MAP_DIR: join(knowledge, 'maps'),
          PHONE_USE_SKILL_DIR: join(knowledge, 'skills'),
          PHONE_USE_NOTES: join(trialDir, 'notes.json'),
          PHONE_USE_TRACE_OUT: join(trialDir, 'trace.zip'),
        };
        onProgress?.(`${task.id} ${arm.id} trial ${repetition + 1}/${contract.repetitions}`);
        const reset = await runComparisonCommand(task.reset, env, contract.timeoutMs);
        await save(join(trialDir, 'reset.json'), reset);
        const row: ComparisonTrial = {
          task: task.id,
          arm: arm.id,
          repetition: repetition + 1,
          state: task.state,
          setupFailed: reset.code !== 0,
          executionFailed: false,
          graded: false,
          passed: false,
          falseSuccess: false,
          durationMs: 0,
          directory: trialDir,
        };
        if (row.setupFailed) row.error = 'Reset failed; agent was not run';
        else {
          const agent = await runComparisonCommand(arm.command, env, contract.timeoutMs);
          await save(join(trialDir, 'agent.json'), agent);
          row.durationMs = agent.durationMs;
          row.executionFailed = agent.code !== 0;
          try {
            const report = reportSchema.parse(JSON.parse(agent.stdout));
            if (report.model !== contract.model)
              throw new Error(`Model mismatch: expected ${contract.model}, got ${report.model}`);
            Object.assign(row, report);
          } catch (error) {
            row.executionFailed = true;
            row.error = `Invalid agent report: ${String(error)}`;
          }
          // The grader runs independently even when the agent claims failure.
          const grade = await runComparisonCommand(task.grade, env, contract.timeoutMs);
          await save(join(trialDir, 'grade.json'), grade);
          try {
            if (grade.code !== 0) throw new Error('Grader process failed');
            const verdict = z.object({ passed: z.boolean() }).parse(JSON.parse(grade.stdout));
            row.graded = true;
            row.passed = verdict.passed && !row.executionFailed;
            row.falseSuccess = row.reportedStatus === 'verified' && !verdict.passed;
          } catch (error) {
            row.error = `${row.error ?? ''} Grading unavailable: ${String(error)}`.trim();
          }
        }
        trials.push(row);
        await save(join(trialDir, 'trial.json'), row);
        await save(join(directory, 'results.json'), {
          schemaVersion: 1,
          contractHash,
          model: contract.model,
          trials,
          summary: summarizeComparison(trials),
        });
      }
    }
  return { directory, contractHash, trials, summary: summarizeComparison(trials) };
}
