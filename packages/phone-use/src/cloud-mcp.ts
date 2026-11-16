import { CloudWaitlistError } from '@phone-use/sdk';
import { CloudApiError, CloudClient, createCloudPhone, type Sandbox } from './cloud-client.ts';

// ---------------------------------------------------------------------------
// The MCP server's one cloud tool: create_cloud_phone.
//
// Every other MCP tool comes from the shared registry and drives a device.
// This one asks the control plane for a cloud phone, which is why it lives
// outside the registry: it is not a device verb, so the CLI verbs and the
// built-in agent loop do not get it.
//
// Cloud phones are on a waitlist. With no API key, or from an account that is
// not approved, the tool returns the waitlist message (the same words
// `phone-use create` prints) as a structured error. Nothing else in the MCP
// server talks to our servers.
// ---------------------------------------------------------------------------

export const CREATE_CLOUD_PHONE_DESCRIPTION =
  'Ask for a cloud phone (a remote iOS simulator or Android emulator). Cloud phones are on a waitlist: ' +
  'unless the account is approved, this returns an error that says how to continue on the local ' +
  'simulator and where the user can join the waitlist. The other tools keep driving this server’s ' +
  'selected device; local devices need no account. Call this only when the user asks for a cloud phone.';

export type CloudToolResult = {
  text: string;
  isError: boolean;
  /** Machine-readable facts, returned as the tool's structured content. */
  structured: Record<string, unknown>;
};

/** How long the tool waits for a queued phone before returning its current state. */
const READY_WAIT_MS = 30_000;

export async function createCloudPhoneForMcp(
  args: { platform?: unknown },
  opts: { readyWaitMs?: number } = {},
): Promise<CloudToolResult> {
  const platform = args.platform === 'android' ? 'android' : 'ios';
  try {
    let sandbox = await createCloudPhone({ surface: 'mcp', platform, wait: false });
    // An MCP call should answer in seconds: wait briefly for a warm phone,
    // then report whatever state it is in.
    const deadline = Date.now() + (opts.readyWaitMs ?? READY_WAIT_MS);
    const client = new CloudClient({ surface: 'mcp' });
    while ((sandbox.status === 'queued' || sandbox.status === 'preparing') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      sandbox = await client.get(sandbox.id);
    }
    return {
      text: describeCreated(sandbox),
      isError: sandbox.status === 'failed',
      structured: { ...sandbox },
    };
  } catch (error) {
    if (error instanceof CloudWaitlistError) {
      return {
        text: error.message,
        isError: true,
        structured: {
          ok: false,
          code: 'cloud_waitlist',
          message: error.message,
          localCommand: error.localCommand,
          waitlistUrl: error.waitlistUrl,
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `ERROR: ${message}`,
      isError: true,
      structured: {
        ok: false,
        code: error instanceof CloudApiError ? (error.code ?? 'error') : 'error',
        message,
      },
    };
  }
}

function describeCreated(sandbox: Sandbox): string {
  const lines = [`Cloud phone ${sandbox.id} (${sandbox.platform}) is ${sandbox.status}.`];
  if (sandbox.error) lines.push(`error: ${sandbox.error}`);
  if (sandbox.status === 'failed') return lines.join('\n');
  const consoleUrl = (process.env.PHONE_USE_CONSOLE_URL ?? 'https://app.phoneuse.dev').replace(/\/+$/, '');
  lines.push(
    `Watch it: ${consoleUrl}/phones/${encodeURIComponent(sandbox.id)}`,
    'This MCP server keeps driving the device it started with. To drive the cloud phone, run in a shell:',
    `  eval "$(phone-use env ${sandbox.id})" && phone-use observe`,
    `or start an MCP server on it with PHONE_USE_DEVICES=cloud:${sandbox.id}`,
    `Close it when you are done: phone-use close ${sandbox.id}`,
  );
  return lines.join('\n');
}
