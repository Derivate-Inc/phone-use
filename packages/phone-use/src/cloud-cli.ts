import { CloudWaitlistError, createCloudSandboxBackend } from '@phone-use/sdk';
import { CloudClient, createCloudPhone, type Sandbox } from './cloud-client.ts';

/**
 * `phone-use checkpoint …` — save/restore the WHOLE device state of the current
 * sandbox (PHONE_USE_SANDBOX_URL/TOKEN, printed by `phone-use env <id>`). A
 * checkpoint is not consumed by restore: one saved state can be re-entered any
 * number of times, which is what makes it a repeatable test fixture.
 */
export async function runCheckpointCli(args: string[]): Promise<number> {
  const [command = 'list', ...rest] = args;
  let backend: ReturnType<typeof createCloudSandboxBackend>;
  try {
    backend = createCloudSandboxBackend();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  switch (command) {
    case 'save': {
      const li = rest.indexOf('--label');
      const label = li !== -1 ? rest[li + 1] : undefined;
      console.log('Saving checkpoint (the phone reboots briefly)…');
      const checkpoint = await backend.checkpoint(label === undefined ? undefined : { label });
      console.log(`Saved ${checkpoint.id}${checkpoint.label ? ` (${checkpoint.label})` : ''}`);
      return 0;
    }
    case 'list': {
      const checkpoints = await backend.listCheckpoints();
      if (rest.includes('--json')) console.log(JSON.stringify(checkpoints, null, 2));
      else if (checkpoints.length === 0) console.log('No checkpoints. Save one: phone-use checkpoint save');
      else {
        console.log('ID                     CREATED                   LABEL');
        for (const c of checkpoints) {
          console.log(`${c.id.padEnd(22)} ${c.createdAt.padEnd(25)} ${c.label ?? ''}`);
        }
      }
      return 0;
    }
    case 'restore': {
      const ref = rest[0];
      if (!ref) {
        console.error('usage: phone-use checkpoint restore <id-or-label>');
        return 1;
      }
      console.log('Restoring (the phone comes back on the saved state)…');
      const result = await backend.restoreCheckpoint(ref);
      console.log(`Restored ${result.checkpointId}`);
      return 0;
    }
    case 'rm': {
      const ref = rest[0];
      if (!ref) {
        console.error('usage: phone-use checkpoint rm <id-or-label>');
        return 1;
      }
      const { deleted } = await backend.deleteCheckpoint(ref);
      console.log(deleted ? `Deleted ${ref}` : `No checkpoint "${ref}"`);
      return deleted ? 0 : 1;
    }
    default:
      console.log(`phone-use checkpoint — save/restore full device state of the current sandbox

  save [--label <name>]    save the phone's state (apps, logins, settings)
  list                     list saved checkpoints
  restore <id|label>       put the phone back on a saved state (repeatable)
  rm <id|label>            delete a checkpoint

Targets the sandbox in PHONE_USE_SANDBOX_URL/TOKEN — set via: eval "$(phone-use env <id>)"`);
      return command === 'help' ? 0 : 1;
  }
}

/**
 * `phone-use traffic` — captured network flows of the attached sandbox
 * (worker must run with PHONE_USE_CAPTURE=1; see apps/api/src/capture.ts).
 */
export async function runTrafficCli(args: string[]): Promise<number> {
  const endpoint = process.env.PHONE_USE_SANDBOX_URL;
  const token = process.env.PHONE_USE_SANDBOX_TOKEN;
  if (!endpoint || !token) {
    console.error('attach a sandbox first: eval "$(phone-use env <id>)"');
    return 1;
  }
  const li = args.indexOf('--limit');
  const limit = li !== -1 ? Number(args[li + 1]) : 100;
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/traffic?limit=${limit}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as {
    flows?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    console.error(body.error ?? `HTTP ${response.status}`);
    return 1;
  }
  const flows = body.flows ?? [];
  if (args.includes('--json')) {
    console.log(JSON.stringify(flows, null, 2));
    return 0;
  }
  if (flows.length === 0) {
    console.log('No captured flows (is capture enabled on the host, and has the phone made requests?)');
    return 0;
  }
  for (const f of flows) {
    const status = f.error ? `ERR ${String(f.error).slice(0, 40)}` : String(f.status ?? '?');
    console.log(`${f.ts}  ${String(f.method).padEnd(6)} ${status.padStart(3)}  ${f.host}${f.path}`);
  }
  return 0;
}

/**
 * `phone-use create | list | env | close` (and `sandbox …`). Expected failures
 * (not signed in, an HTTP error from the API, a timeout) print one line and
 * exit 1, rather than surfacing as an uncaught error with a stack trace.
 *
 * Cloud phones are on a waitlist: `create` with no key, or from an account
 * that is not approved, prints the waitlist message (written for the coding
 * agent that usually runs this) and exits 1.
 */
export async function runSandboxCli(args: string[]): Promise<number> {
  try {
    return await sandboxCli(args);
  } catch (error) {
    if (error instanceof CloudWaitlistError) {
      // stderr, like every other failure here: `id=$(phone-use create ios | …)`
      // must capture nothing. --json callers get the same facts on stdout.
      if (args.includes('--json')) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              code: 'cloud_waitlist',
              message: error.message,
              localCommand: error.localCommand,
              waitlistUrl: error.waitlistUrl,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(error.message);
      }
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function sandboxCli(args: string[]): Promise<number> {
  const [command = 'help', ...rest] = args;
  // `create` is not here: with no key it answers with the waitlist message,
  // not "not signed in" (createCloudPhone builds its own client).
  const client = ['list', 'get', 'status', 'close', 'rm'].includes(command) ? new CloudClient() : undefined;

  switch (command) {
    case 'create': {
      const platform = rest[0];
      if (platform !== 'ios' && platform !== 'android') {
        console.error('usage: phone-use create <ios|android> [--ttl 60m] [--idle 15m] [--no-wait]');
        return 1;
      }
      const ttlMs = durationFlag(rest, '--ttl');
      const idleRaw = flagValue(rest, '--idle');
      const idleTimeoutMs = idleRaw === 'off' ? false : idleRaw ? parseDuration(idleRaw) : undefined;
      const sandbox = await createCloudPhone({
        surface: 'cli',
        platform,
        ...(ttlMs === undefined ? {} : { ttlMs }),
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
        wait: !rest.includes('--no-wait'),
      });
      printSandbox(sandbox, rest.includes('--json'));
      return sandbox.status === 'failed' ? 1 : 0;
    }
    case 'list': {
      const sandboxes = await client!.list();
      if (rest.includes('--json')) console.log(JSON.stringify(sandboxes, null, 2));
      else if (sandboxes.length === 0) console.log('No sandboxes.');
      else {
        console.log('ID                                    PLATFORM  STATUS      EXPIRES');
        for (const sandbox of sandboxes) {
          console.log(
            `${sandbox.id.padEnd(37)} ${sandbox.platform.padEnd(9)} ${sandbox.status.padEnd(11)} ${sandbox.expiresAt}`,
          );
        }
      }
      return 0;
    }
    case 'get':
    case 'status': {
      const id = rest[0];
      if (!id) {
        console.error(`usage: phone-use sandbox ${command} <id>`);
        return 1;
      }
      printSandbox(await client!.get(id), rest.includes('--json'));
      return 0;
    }
    case 'env': {
      const id = rest[0];
      if (!id) {
        console.error('usage: phone-use env <id>   # eval "$(phone-use env <id>)"');
        return 1;
      }
      const envClient = new CloudClient();
      // A sandbox reports `running` the moment its status flips, but the
      // connection pair is attached a beat later. Without this wait, `env`
      // immediately after `create` fails with the baffling "sandbox X is
      // running" — the status is fine, it is the connection that is missing.
      let sandbox = await envClient.get(id);
      for (let attempt = 0; attempt < 10 && sandbox.status === 'running' && !sandbox.connection; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        sandbox = await envClient.get(id);
      }
      if (sandbox.status !== 'running') {
        console.error(`sandbox ${id} is ${sandbox.status}${sandbox.error ? `: ${sandbox.error}` : ''}`);
        return 1;
      }
      if (!sandbox.connection) {
        console.error(
          `sandbox ${id} is running but published no connection — retry, or close and recreate it`,
        );
        return 1;
      }
      console.log(`export PHONE_USE_SANDBOX_URL=${sandbox.connection.endpoint}`);
      console.log(`export PHONE_USE_SANDBOX_TOKEN=${sandbox.connection.token}`);
      return 0;
    }
    case 'close':
    case 'rm': {
      const id = rest[0];
      if (!id) {
        console.error('usage: phone-use close <id> [--no-wait]');
        return 1;
      }
      const sandbox = await client!.close(id, { wait: !rest.includes('--no-wait') });
      printSandbox(sandbox, rest.includes('--json'));
      return sandbox.status === 'failed' ? 1 : 0;
    }
    default:
      console.log(`phone-use <create|list|env|close>   (also: phone-use sandbox <sub>)

  create <ios|android>   provision a cloud phone and wait until ready
                         (waitlist: https://phoneuse.dev/waitlist)
  list                   list sandboxes
  status <id>            show one sandbox
  env <id>               print PHONE_USE_SANDBOX_* exports for this sandbox
  close <id>             destroy a sandbox

Options:
  --ttl <30m|2h>         hard lifetime (default 1h, max 24h)
  --idle <15m|off>       idle teardown (default 15m)
  --no-wait              return after queueing the operation
  --json                 machine-readable output

Environment:
  PHONE_USE_CLOUD_URL    control-plane URL
  PHONE_USE_CLOUD_TOKEN  client API token

Drive a running sandbox (any verb, MCP, or the agent):
  eval "$(phone-use env <id>)" && phone-use observe

Cloud phones are on a waitlist. With no cloud phone attached, the same verbs
drive the iOS Simulator on this Mac or an Android device over adb, and need
no account:
  phone-use observe`);
      return command === 'help' ? 0 : 1;
  }
}

function printSandbox(sandbox: Sandbox, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(sandbox, null, 2));
    return;
  }
  console.log(`${sandbox.id}  ${sandbox.platform}  ${sandbox.status}`);
  if (sandbox.error) console.log(`error: ${sandbox.error}`);
  if (sandbox.status === 'running') {
    console.log(
      `watch: ${(process.env.PHONE_USE_CONSOLE_URL ?? 'https://app.phoneuse.dev').replace(/\/+$/, '')}/phones/${encodeURIComponent(sandbox.id)}`,
    );
    console.log(`use: eval "$(phone-use env ${sandbox.id})" && phone-use observe`);
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function durationFlag(args: string[], name: string): number | undefined {
  const value = flagValue(args, name);
  return value ? parseDuration(value) : undefined;
}

export function parseDuration(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`invalid duration "${value}" (use 30s, 15m, 2h, or 1d)`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!;
  return amount * multiplier;
}
