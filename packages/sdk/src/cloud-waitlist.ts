import { PhoneUseError } from './errors.ts';

// ---------------------------------------------------------------------------
// Cloud phones are on a waitlist. Local devices are not: the iOS Simulator and
// Android over adb need no account. When a cloud phone is asked for and not
// given, every surface (CLI, MCP server, SDK) says the same three things, in
// words written for the coding agent that is usually the caller:
//   1. cloud phones are on a waitlist, so nothing was created;
//   2. the work can continue on this machine, with the exact next step;
//   3. tell the user where the waitlist is.
// The wording lives here so the surfaces cannot drift apart.
// ---------------------------------------------------------------------------

/** Where people join the cloud waitlist. */
export const CLOUD_WAITLIST_URL = 'https://phoneuse.dev/waitlist';

/** The `code` the control plane returns when a create is refused by the waitlist. */
export const CLOUD_WAITLIST_CODE = 'cloud_waitlist';

/** Which surface asked for the cloud phone; it decides how the next step is phrased. */
export type CloudWaitlistSurface = 'cli' | 'mcp' | 'sdk';

/** What was asked for, and where, when the waitlist answered. */
export type CloudWaitlistContext = {
  surface: CloudWaitlistSurface;
  /** The platform that was asked for. Default `ios`. */
  platform?: 'ios' | 'android' | undefined;
  /** The machine's OS (`process.platform`). The iOS Simulator only exists on `darwin`. */
  hostPlatform?: string | undefined;
  /** False when no API key was present at all, so signing in may be all that is missing. */
  signedIn?: boolean | undefined;
  /** The waitlist link the control plane sent, when it sent one. */
  waitlistUrl?: string | undefined;
};

/** The local device to use instead, and the exact step that starts it. */
export type CloudWaitlistLocalStep = {
  /** What runs locally, in a few words. */
  device: string;
  /** The command, tool call or line of code to run next. */
  command: string;
  /** What to do when that step does not work first time. */
  note?: string | undefined;
};

/** The local alternative to the cloud phone that was asked for. */
export function cloudWaitlistLocalStep(ctx: CloudWaitlistContext): CloudWaitlistLocalStep {
  const host = ctx.hostPlatform ?? process.platform;
  // The iOS Simulator needs a Mac; anywhere else the local device is Android.
  const android = ctx.platform === 'android' || host !== 'darwin';
  if (ctx.surface === 'sdk') {
    return android
      ? {
          device: 'an Android emulator or device over adb',
          command: "import { android } from '@phone-use/sdk'; const device = await android.connect();",
        }
      : {
          device: 'the local iOS Simulator',
          command: "import { ios } from '@phone-use/sdk'; const device = await ios.launch();",
        };
  }
  // Explicit device selection overrides a saved real-device choice or stale
  // cloud exports, without changing the user's saved config. Clear remote
  // URLs for iOS as well so its shared-simulator lease is still acquired.
  const command = android
    ? 'PHONE_USE_DEVICE=android phone-use observe'
    : 'open -a Simulator && PHONE_USE_DEVICE=connect PHONE_USE_SANDBOX_URL= PHONE_USE_RUNNER_URL= phone-use observe';
  const simulatorNote =
    'If it says no simulator is booted, wait a few seconds and retry the same command. ' +
    '`phone-use doctor` checks the setup.';
  const mcpNote =
    'Run this in a shell. This MCP server stays bound to its original device. ' +
    'If it already drives that local device, use its observe tool; otherwise restart it with ' +
    `\`phone-use mcp --devices local=${android ? 'android' : 'connect'}\`.`;
  return android
    ? {
        device: 'an Android emulator or device over adb',
        command,
        note:
          ctx.surface === 'mcp' ? mcpNote : 'Start an Android emulator or attach a device with adb first.',
      }
    : {
        device: 'the local iOS Simulator',
        command,
        // `open` returns before the simulator has booted, so the first observe
        // after a cold start can be too early. Measured: it works seconds later.
        note: ctx.surface === 'mcp' ? `${mcpNote} ${simulatorNote}` : simulatorNote,
      };
}

/**
 * The message shown when a cloud phone is asked for and the waitlist answers.
 * Written for a coding agent: what happened, the exact next step on this
 * machine, and what to tell the user.
 */
export function cloudWaitlistMessage(ctx: CloudWaitlistContext): string {
  const host = ctx.hostPlatform ?? process.platform;
  const step = cloudWaitlistLocalStep(ctx);
  const url = ctx.waitlistUrl ?? CLOUD_WAITLIST_URL;
  const iosElsewhere = (ctx.platform ?? 'ios') === 'ios' && host !== 'darwin';
  const lines = [
    'Cloud phones are on a waitlist, so no cloud phone was created.',
    '',
    iosElsewhere
      ? `You can keep working on this machine without an account. The iOS Simulator needs a Mac, so use ${step.device}:`
      : `You can keep working on this machine without an account, on ${step.device}:`,
    `  ${step.command}`,
    ...(step.note ? [step.note] : []),
    '',
    `Tell the user: cloud phones are on a waitlist, and they can join it at ${url}`,
  ];
  if (ctx.signedIn === false) {
    lines.push(
      ctx.surface === 'sdk'
        ? 'If their account is already approved, pass its API key (PHONE_USE_CLOUD_TOKEN).'
        : 'If their account is already approved, run `phone-use login` and try again.',
    );
  }
  return lines.join('\n');
}

/**
 * A cloud phone was asked for and the waitlist answered (`CLOUD_WAITLIST`,
 * not retryable). `message` is {@link cloudWaitlistMessage}; `localCommand`
 * and `waitlistUrl` carry its two actionable parts for callers that branch.
 */
export class CloudWaitlistError extends PhoneUseError {
  /** The exact next step that continues the work on this machine. */
  readonly localCommand: string;
  /** Where the user joins the waitlist. */
  readonly waitlistUrl: string;

  constructor(ctx: CloudWaitlistContext, opts: { cause?: unknown } = {}) {
    const localCommand = cloudWaitlistLocalStep(ctx).command;
    const waitlistUrl = ctx.waitlistUrl ?? CLOUD_WAITLIST_URL;
    super(cloudWaitlistMessage(ctx), {
      code: 'CLOUD_WAITLIST',
      retryable: false,
      details: { localCommand, waitlistUrl, surface: ctx.surface, backendCode: CLOUD_WAITLIST_CODE },
      ...(opts.cause === undefined ? {} : { cause: opts.cause }),
    });
    this.localCommand = localCommand;
    this.waitlistUrl = waitlistUrl;
  }
}
