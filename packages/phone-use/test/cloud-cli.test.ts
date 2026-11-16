import { cloudWaitlistMessage } from '@phone-use/sdk';
import { describe, expect, it, vi } from 'vitest';
import { parseDuration, runSandboxCli } from '../src/cloud-cli.ts';

describe('cloud CLI durations', () => {
  it('parses compact duration flags', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('rejects ambiguous values', () => {
    expect(() => parseDuration('15')).toThrow('invalid duration');
  });
});

describe('cloud CLI errors', () => {
  it('reports "not signed in" as one line and exit 1, not a stack trace', async () => {
    const saved = { token: process.env.PHONE_USE_CLOUD_TOKEN, error: console.error };
    const lines: string[] = [];
    Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runSandboxCli(['list'])).toBe(1);
      expect(await runSandboxCli(['close', 'sbx_1'])).toBe(1);
    } finally {
      console.error = saved.error;
      if (saved.token !== undefined) process.env.PHONE_USE_CLOUD_TOKEN = saved.token;
    }
    expect(lines).toEqual([
      'Not signed in — run `phone-use login` (or set PHONE_USE_CLOUD_TOKEN)',
      'Not signed in — run `phone-use login` (or set PHONE_USE_CLOUD_TOKEN)',
    ]);
  });
});

// Cloud phones are on a waitlist. `create` is where people meet it.
describe('phone-use create and the cloud waitlist', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

  /** Run the CLI with a stubbed control plane; capture what it printed and what it sent. */
  async function run(
    args: string[],
    opts: { token?: string; respond?: (call: Call) => Response | Promise<Response> } = {},
  ) {
    const saved = {
      token: process.env.PHONE_USE_CLOUD_TOKEN,
      url: process.env.PHONE_USE_CLOUD_URL,
      error: console.error,
      log: console.log,
    };
    const stderr: string[] = [];
    const stdout: string[] = [];
    const calls: Call[] = [];
    if (opts.token) process.env.PHONE_USE_CLOUD_TOKEN = opts.token;
    else Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
    process.env.PHONE_USE_CLOUD_URL = 'http://control.test';
    console.error = (line: unknown) => void stderr.push(String(line));
    console.log = (line: unknown) => void stdout.push(String(line));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return opts.respond ? opts.respond(call) : Response.json({ recorded: true }, { status: 202 });
    });
    try {
      const code = await runSandboxCli(args);
      return { code, stderr: stderr.join('\n'), stdout: stdout.join('\n'), calls };
    } finally {
      vi.unstubAllGlobals();
      console.error = saved.error;
      console.log = saved.log;
      if (saved.token === undefined) Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_TOKEN');
      else process.env.PHONE_USE_CLOUD_TOKEN = saved.token;
      if (saved.url === undefined) Reflect.deleteProperty(process.env, 'PHONE_USE_CLOUD_URL');
      else process.env.PHONE_USE_CLOUD_URL = saved.url;
    }
  }

  const refusal = () =>
    Response.json(
      {
        error: 'Cloud phones are on a waitlist. Join it at https://example.test/join.',
        code: 'cloud_waitlist',
        waitlistUrl: 'https://example.test/join',
      },
      { status: 403 },
    );

  it('logged out: prints the waitlist message for a coding agent and exits non-zero', async () => {
    const result = await run(['create', 'ios']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(cloudWaitlistMessage({ surface: 'cli', platform: 'ios', signedIn: false }));
    // The three things the message must say.
    expect(result.stderr).toContain('Cloud phones are on a waitlist, so no cloud phone was created.');
    expect(result.stderr).toContain('phone-use observe');
    expect(result.stderr).toContain('Tell the user');
    expect(result.stderr).toContain('https://phoneuse.dev/waitlist');
    expect(result.stderr).toContain('phone-use login');
  });

  it('logged out: the attempt is reported once, with the platform and the surface and nothing else', async () => {
    const result = await run(['create', 'android', '--ttl', '15m']);
    expect(result.calls).toHaveLength(1);
    const [call] = result.calls;
    expect(call?.url).toBe('http://control.test/v1/waitlist/attempts');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ platform: 'android', client: 'cli' });
    expect(call?.headers.authorization).toBeUndefined();
    expect(result.stderr).toContain('PHONE_USE_DEVICE=android phone-use observe');
  });

  it('logged out and offline: still the waitlist message, still exit 1', async () => {
    const result = await run(['create', 'ios'], {
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cloud phones are on a waitlist');
  });

  it('signed in but not approved: the cloud_waitlist answer becomes the same message', async () => {
    const result = await run(['create', 'ios'], { token: 'pk_waiting', respond: refusal });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      cloudWaitlistMessage({
        surface: 'cli',
        platform: 'ios',
        signedIn: true,
        waitlistUrl: 'https://example.test/join',
      }),
    );
    expect(result.stderr).not.toContain('phone-use login');
    // One request: the create itself, marked as coming from the CLI. No second report.
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.url).toBe('http://control.test/v1/sandboxes');
    expect(result.calls[0]?.headers['x-phone-use-client']).toBe('cli');
    expect(result.calls[0]?.headers.authorization).toBe('Bearer pk_waiting');
  });

  it('--json puts the same facts on stdout for scripts', async () => {
    const result = await run(['create', 'ios', '--json'], { token: 'pk_waiting', respond: refusal });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      code: 'cloud_waitlist',
      message: expect.stringContaining('Cloud phones are on a waitlist'),
      localCommand: expect.stringContaining('phone-use observe'),
      waitlistUrl: 'https://example.test/join',
    });
  });

  it('an approved account still gets its phone', async () => {
    const sandbox = {
      id: 'sbx_approved',
      platform: 'ios',
      status: 'running',
      createdAt: '2026-11-13T00:00:00.000Z',
      expiresAt: '2026-11-13T01:00:00.000Z',
      idleTimeoutMs: 900_000,
    };
    const result = await run(['create', 'ios'], {
      token: 'pk_approved',
      respond: () => Response.json(sandbox, { status: 202 }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('sbx_approved  ios  running');
    expect(result.stdout).toContain('phone-use env sbx_approved');
  });

  it('other API errors are still reported as they were', async () => {
    const result = await run(['create', 'ios'], {
      token: 'pk_approved',
      respond: () => Response.json({ error: 'no ios capacity available yet' }, { status: 503 }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('no ios capacity available yet');
  });

  it('a missing platform is still a usage error, with no request made', async () => {
    const result = await run(['create']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('usage: phone-use create <ios|android>');
    expect(result.calls).toEqual([]);
  });
});

describe('phone-use login: what to try next', () => {
  it('points an account on the waitlist at the local simulator, not at create', async () => {
    const { nextStepAfterLogin } = await import('../src/login.ts');
    const waiting = nextStepAfterLogin({
      name: 'Dev',
      cloudApproved: false,
      waitlistUrl: 'https://example.test/join',
    });
    expect(waiting).toContain('Cloud phones are on a waitlist for this account: https://example.test/join');
    expect(waiting).toContain('phone-use observe');
    expect(waiting).not.toContain('phone-use create');
  });

  it('keeps the create hint for an approved account and for an older control plane', async () => {
    const { nextStepAfterLogin } = await import('../src/login.ts');
    expect(nextStepAfterLogin({ cloudApproved: true })).toBe('Try it: phone-use create ios');
    expect(nextStepAfterLogin({ name: 'Dev' })).toBe('Try it: phone-use create ios');
  });
});
