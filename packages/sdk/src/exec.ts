import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Per-call options an {@link ExecRunner} accepts. */
export type ExecOptions = {
  /** Kill the process after this many ms (rejects in the killed shape). */
  timeoutMs?: number | undefined;
  /** Replacement environment for the child process. */
  env?: Record<string, string> | undefined;
};

/** What an {@link ExecRunner} resolves with on exit 0. */
export type ExecResult = { stdout: string; stderr: string };

/**
 * The process-execution seam (dependency-inject the spawn/exec runner
 * so unit tests run without the real binaries). Runners are dumb: resolve on
 * exit 0, reject with the execFile error shape otherwise — error normalization
 * to PhoneUseError happens at the call site, once.
 */
export type ExecRunner = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

const pExecFile = promisify(execFile);

export const defaultExecRunner: ExecRunner = async (file, args, opts) => {
  const { stdout, stderr } = await pExecFile(file, args, {
    encoding: 'utf8',
    // simctl `list devices -j` on a runtime-rich Mac can exceed the 1 MiB
    // default and fail spuriously — a failure the VPS test tier can never see.
    maxBuffer: 16 * 1024 * 1024,
    ...(opts?.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
    ...(opts?.env === undefined ? {} : { env: opts.env }),
  });
  return { stdout, stderr };
};

/** The execFile rejection shape runners produce (structural, for call sites). */
export type ExecError = Error & {
  code?: number | string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  killed?: boolean | undefined;
  signal?: string | undefined;
};

export function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && ('code' in err || 'killed' in err || 'stderr' in err);
}
